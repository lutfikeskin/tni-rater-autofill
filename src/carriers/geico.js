// @ts-check
// GEICO commercial auto (sales.geico.com/quote), opened from the agents' gateway
// (gateway2.geico.com), where only the Start New Quote window (ZIP) and the USDOT check are filled.
//
// A single-page application on one address. Its steps (Business Class & USDOT … Payment
// Information) are told apart by the progress bar at the top: the one part between 0 and 100,
// which document.title names too (pagekit stepKey; no step is read when the two disagree). Every
// rule names the step(s) it answers on (`steps`): GiveFirstName is the business owner on Business
// & Owner Info and a driver on Drivers & Incidents, GiveZip the business ZIP on one step and where
// a vehicle is parked on another.
//
// A question is found by its data-model name (`field`): GEICO draws it as Id_<Name>_<render
// number> and renumbers it on every redraw (field-key.js dataName), so no rule holds the number.
// `ask` is GEICO's question text as the page kit reads it, a check on the name (other words: still
// answered, and flagged). It is given only where it was read from the saved NE pages with the kit's
// shadow-DOM label reading, or from the FL captures for text boxes and lists (layouts/geico,
// 2026-10, kept local): those captures show radios by a humanized id, never their question. The
// coverage lists on Quote & Coverages have no name and a new id on every render and Recalculate: a
// policy-level one is found by its caption, a vehicle's row by the coverage its id ends in.
//
// The Vehicles and Drivers & Incidents steps show one form at a time, each for one unit: a vehicle,
// a trailer, an added driver, or the driver GEICO adds for an owner who drives. Which form is up is
// told by a question only that form asks (`whenShown` / `unlessShown`): the vehicle form's first
// question (is the VIN at hand?), the trailer form's type list ("…the customer's trailer?"), Add
// Driver's relationship question. A form's unit is the panel's active vehicle, trailer or driver,
// and `unit` makes that question the form's identity: a form filled for one unit is never filled
// again with another's (the kit holds it until the agent picks its unit in the panel).
//
// Mapped from the saved NE pages and the FL captures (2026-10-20). A question the intake answers is
// filled from it (`intake`, or `derived` by an exact transform below, each with a case close by
// where it must not apply). TNI's own answers for GEICO (`standard`, after the first FL live run,
// 2026-10-21; docs/intake-and-rules.md) fill what the intake doesn't. Every other question is the
// agent's: a `fact` or `attestation` with a short note, since GEICO's humanized radio labels slip
// past the AI assistant's own guards and an unmapped one would be offered to it; or a choice the
// agent makes from a long list with the intake's words quoted (business description, vehicle and
// trailer type), which the AI assistant may suggest for the agent's approval.
//
// On Quote & Coverages the fill opens Motor Truck Cargo when the intake asks for it; once nothing
// there is left for the agent and the page is quiet it clicks Recalculate, once a quote, checks
// every answer after GEICO's redraw, and with the premium current picks 11 Payments (or the plan
// with the most payments offered) under View More Payment Plans and prints the quote proposal (TNI,
// FL live runs 4 and 6, 2026-10-21; W43-31, W43-32). The quote stops at Quote & Coverages: Final Quote Details leads to MVR & CLUE,
// which orders paid reports (stopSteps: nothing is filled or clicked there). With "Fill the pages" or
// "Click Continue when the page is done" on, or on the agent's Fill this page, the fill adds each
// intake vehicle, trailer and driver not on the quote yet (TNI, 2026-10-21): the list's "+", the
// chooser's Vehicle or Trailer and its Next (`actions`, unitLists). With "Click Continue when the
// page is done" on, once nothing is left for the agent it clicks Next (Save and Continue on Add
// Driver) on each step up to Additional Business Info, and Looks Good on a unit list once every
// intake unit is on it (`advance`, TNI, FL live run 3, 2026-10-21); off, the agent clicks them.

import { owner, ownerDobNote as noOwnerDob, HAZ_HAUL } from '../util.js';
import { STANDARDS, usd } from '../standards.js';
import { isLongHaul, otherNotes, parseRadius, cdlStandard, cdlAnswer, ntlNoDotFilings, ntlUndecided, ntlDotFilingsHold, insurerTenure, tenureBand } from '../normalize.js';
import { noPriorInsurance, priorPolicyExpired, ownerIsDriver, companyName, companyStructure, companyStructureWarn, companyStructureNote, sameCarrier, priorPolicyCurrent, untypedCarrierPolicy, priorInsuranceAssumed, noCargoDeductible, CARGO_DEDUCTIBLE_NOTE, haulsGeneralFreight, haulsCarParts, carPartsMixed, carPartsMixedNote, CARS } from '../util.js';
import { ownerDrives, ownerDrivesSaid, ownerDrivesSource, ownerDrivesWarn, ownerDailyOps, ownerDailyOpsSource, driverExcluded, ownerExcluded, ownerRow, nonDrivingOwnerRow } from '../util.js';
import { glRequested, glAnswer, GL_OIL_GAS, interchangeRequested, interchangeUnrequested, INTERCHANGE_TRAILERS, interchangeLimitPick, interchangeLimitNote, interchangeLimitRaised,
  interchangeLimitSource, interchangeTrailerType, interchangeTypeSaid } from '../util.js';

/** @import { CarrierAction, CarrierConfig, CarrierRule, ShownCondition } from '../../types.js' */

const STEPS = ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents',
  'Additional Business Info', 'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information'];
const [BUSINESS_CLASS, BUSINESS_OWNER, VEHICLES, DRIVERS, MORE_BUSINESS, COVERAGES] = STEPS;

// The quote itself, never the agents' dashboard (sales.geico.com/dashboard).
const QUOTE = /^https:\/\/sales\.geico\.com\/quote(?:[?#/]|$)/i;
// Filled: the quote, and the gateway's pages, where a quote starts with its ZIP in the Start New
// Quote window (drawn over any gateway page: FL live run, 2026-10-21, over Recent Policies and Quotes).
const FILLED = /^https:\/\/(?:sales\.geico\.com\/quote|gateway2\.geico\.com)(?:[?#/]|$)/i;
const GATEWAY = /^https:\/\/gateway2\.geico\.com(?:[?#/]|$)/i;
// The quote's own page, where the gateway's rules never apply.
const GATEWAY_OFF = ['/quote'];
// The Search Products window's product boxes (Auto, Commercial Auto/Trucking, Motorcycle, Umbrella).
const PRODUCT = 'input[name="lob-selection"]';
const STOP_AT_QUOTE = 'TNI stops GEICO quotes at Quote & Coverages: go back there and print the quote proposal.';

// The forms of one step, by a question only that form asks.
// - The vehicle form's first question, on all four FL vehicle forms and the NE one (absent on the
//   trailer form): its id's render number is also the form's identity.
/** @type {ShownCondition} */
const VEHICLE_FORM = { field: 'YesNoPreQuoteHaveFullVinActivity', unit: 'vehicles' };
// - The trailer form's type list ("Which of the following best describes the customer's trailer?",
//   NE); the vehicle form's reads "…vehicle?". On 2026-10 NE the truck's year went into it.
/** @type {ShownCondition} */
const TRAILER_FORM = { field: 'GiveOtherVehicleType', label: '\\btrailer\\b', unit: 'trailers' };
// - Add Driver's relationship question; the form GEICO adds for an owner who drives doesn't ask it.
/** @type {ShownCondition} */
const ADD_DRIVER_FORM = { field: 'GiveDriverRelationshipToBusiness', unit: 'drivers' };
/** @type {ShownCondition} */
const OWNER_DRIVER_FORM = { field: 'GiveDriverRelationshipToBusiness' };
// - The owner's identity again, with their Social Security number (FL capture 007, after Business
//   & Owner Info's Next, under the title of Vehicles).
/** @type {ShownCondition} */
const OWNER_CHECK = { field: 'GiveSocialSecurityNumber' };

// The lists of the units on the quote (NE Vehicles2, Drivers & Incidents2): one row per unit, a
// vehicle's or trailer's with its VIN in its headline, a driver's with their name, and last the add
// row, whose "+" (an icon, data-testid addIcon) opens the chooser or Add Driver. The incidents' list
// below the drivers has an add row of its own: each "+" is found within its own list's add row.
const VEHICLE_LIST = '#summaryPage-AddCommercialVehicle';
const DRIVER_LIST = '#summaryPage-AddDriver';
// The chooser's buttons (NE Vehicles3): Next, which opens the form for the unit picked, and Cancel.
const CHOOSER_BUTTONS = '[id^="Id_VehicleOrTrailerCollectAdaptiveActionSet_Container_"]';

// A step's rules (the whole step, or one form of it with `form`).
/**
 * @param {string | string[]} steps
 * @param {CarrierRule} form
 * @param {CarrierRule[]} rules
 * @returns {CarrierRule[]}
 */
const on = (steps, form, rules) => rules.map((rule) => ({ steps: [].concat(steps), ...form, ...rule }));
// Facts the intake doesn't supply are the agent's (plan.js: `source: 'fact'` is never filled); with
// no note the panel says "<name> isn't on the intake: answer it yourself."
/** @param {string} field @param {string} name @param {CarrierRule} [more] @returns {CarrierRule} */
const fact = (field, name, more = {}) => ({ field, name, source: 'fact', ...more });
const quote = (v, n = 60) => `"${String(v).trim().slice(0, n)}"`;

// --- Business ----------------------------------------------------------------------------------

// GEICO's ZIP boxes take 5 digits: a ZIP+4 is cut to its ZIP (12345-6789), anything else is the
// agent's. A different ZIP already on the page (the gateway's, GEICO's own) is kept and flagged.
const zip5 = (r) => String(r.garaging?.zip ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)?.[1] ?? null;
const zipNote = (r) => (r.garaging?.zip && !zip5(r) ? `The intake's ZIP ${quote(r.garaging.zip)} isn't a 5-digit ZIP: enter it yourself.` : null);

// "Does the customer have a USDOT Number registered to themselves or their business?" Yes with a
// number; No only when the intake says none is coming within 60 days and there is no MC number;
// "Not yet, but the customer has applied for one." when the intake's 60-day box is Yes (TNI,
// 2026-10-27: that Yes means they will apply / have applied — same idea as Progressive's "Not Yet";
// until then it was the agent's). "No" in the intake's USDOT box (`noDot`, also "None" or "N/A")
// is No too (TNI, 2026-10-26: answer to PR question), unless the 60-day answer says one is coming
// (R13). With an MC number too (TNI, 2026-10-26: answer to PR question, R12): the box's explicit No
// answers it, where an MC number with a blank USDOT box stays the agent's.
// On an NTL quote No, and the number is typed nowhere, the gateway included (TNI, 2026-10-26, W44-28:
// "US DOT is not added … if its NTL, in every case"); the intake's own No stays `derived`.
const DOT_NOT_YET = 'Not yet, but the customer has applied for one.';
const intakeDotNo = (r) => !r.applicant.dot && (r.applicant.noDot === true && r.applicant.mcDotWithin60Days !== true
  || !r.applicant.mc && r.applicant.mcDotWithin60Days === false);
const dotStatus = (r) => (ntlNoDotFilings(r) ? 'No' : r.applicant.dot ? 'Yes'
  : r.applicant.mcDotWithin60Days === true ? DOT_NOT_YET : intakeDotNo(r) ? 'No' : null);
const dotStatusSource = (r) => (ntlNoDotFilings(r) && !intakeDotNo(r) ? 'standard' : 'derived');
const noDotOnQuote = (r) => !r.applicant.dot || ntlNoDotFilings(r);
const dotStatusNote = (r) => (dotStatus(r) ? null
  : r.applicant.mc ? 'The intake has an MC number but no USDOT number: answer it yourself.'
    : 'The intake has no USDOT number and doesn\'t say whether one is coming: answer it yourself.');
const dotNumberNote = (r) => (!noDotOnQuote(r) && !/^\d+$/.test(r.applicant.dot) ? 'The intake\'s USDOT number isn\'t digits only: enter it yourself.' : null);

// "Does the customer's business have a current GEICO commercial auto policy?" from the intake's
// current-insurance row. No for no prior insurance, a personal auto policy, or a commercial auto
// policy with another carrier; Yes for a current GEICO commercial auto policy. A blank section, an
// expired GEICO policy, or another kind of policy (GL, cargo) or one of no type is the agent's:
// Progressive's reading of a blank section as No is Progressive's. GEICO misspelled or with a
// suffix ("GICO", "Gieco", "Geico Commercial") is GEICO (sameCarrier; TNI, 2026-10-26, W44-06):
// it used to be read as another carrier, No. An undated GEICO commercial auto policy (no expiration
// date, or a remark in the date box) is Yes too, TNI's answer, a standard (TNI, 2026-10-26: answer
// to PR question 9, by W44-29's proof of prior: priorPolicyCurrent); it used to be the agent's.
// A GEICO policy whose type is left blank stays the agent's, now a `fact` with a note that the type
// isn't on the intake (TNI, 2026-10-26: answer to PR question R9: untypedCarrierPolicy).
const prior = (r) => r.priorInsurance?.[0] ?? null;
const commercialAuto = (p) => /commercial\s+auto/i.test(p?.type ?? '');
const currentGeico = (r) => {
  const p = prior(r);
  if (!p) return null;
  if (noPriorInsurance(p) || /personal\s+auto/i.test(p.type ?? '')) return false;
  if (!p.carrier) return null;
  if (!sameCarrier(p.carrier, 'geico')) return commercialAuto(p) ? false : null;
  return commercialAuto(p) && priorPolicyCurrent(r, p) ? true : null;
};
const untypedGeico = (r) => untypedCarrierPolicy(prior(r), 'geico');
// Derived from a dated policy; TNI's standard when the Yes is the answer to question 9 (undated); a
// fact, the agent's, for a GEICO policy of no type (R9).
const currentGeicoSource = (r) => (untypedGeico(r) ? 'fact'
  : currentGeico(r) === true && !DATE.test(prior(r)?.expiration ?? '') ? 'standard' : 'derived');
const currentGeicoNote = (r) => (untypedGeico(r) ? 'The intake\'s current policy is with GEICO, but its policy type isn\'t on the intake: answer it yourself.'
  : currentGeico(r) != null ? null
    : !prior(r) ? 'The intake\'s current insurance section is blank: answer it yourself.'
      : 'The intake\'s current insurance doesn\'t show whether there is a current GEICO commercial auto policy: answer it yourself.');

const HAULED = (r) => [r.operations.businessClass && `the business class is ${quote(r.operations.businessClass)}`,
  r.operations.whatHaul && `they haul ${quote(r.operations.whatHaul)}`].filter(Boolean).join(' and ');
const describeNote = (what) => (r) => `${what} is yours to pick${HAULED(r) ? ` (on the intake ${HAULED(r)})` : ''}.`;
// An expediter or a general freight hauler (the business class, as Progressive reads it): the
// classes TNI's GEICO standards were set for (supportedClasses), and For Hire Trucking, then Other
// For-Hire Trucking, on Business Class & USDOT (TNI, 2026-10-21: "that's the equivalent of
// Expediter and General Freight Hauler").
const FOR_HIRE_CLASSES = [/expedit/i, /^(?:general\s+)?freight\s+haul(?:er|ing)$/i];
const forHire = (r) => FOR_HIRE_CLASSES.some((re) => re.test(String(r.operations.businessClass ?? '').trim()));
const describeSource = (r) => (forHire(r) ? 'standard' : 'derived');

// The first line of the intake's notes (the claims box's other lines, the Additional Notes box)
// these words are in, cut short: what makes a TNI standard below the agent's, quoted.
const notesLine = (words) => (r) => String(otherNotes(r) ?? '').split('\n').map((s) => s.trim()).find((s) => words.test(s))?.slice(0, 80) ?? null;
// A yes/no question TNI answers No when the intake is silent (TNI, 2026-10-21, W43-34: "No unless the
// intake says otherwise"): the intake's own answer when it gives one; none, and something on the
// intake pointing the other way (`otherwise`: what it says, or null), is the agent's, with it quoted.
const noUnless = (answer, otherwise) => ({
  value: (r) => (typeof answer(r) === 'boolean' ? answer(r) : otherwise(r) ? null : false),
  source: (r) => (typeof answer(r) === 'boolean' ? 'intake' : otherwise(r) ? 'fact' : 'standard'),
});

// Team driving or slip seating: No unless the notes mention a team, slip seating or co-drivers.
const TEAM = /\bteams?\b|\bslip[\s-]*seat\w*|\bco-?drivers?\b/i;
const teamMention = notesLine(TEAM);
const teamNote = (r) => (typeof r.operations.teamDriving !== 'boolean' && teamMention(r)
  ? `The intake doesn't answer team driving or slip seating, and its notes say ${quote(teamMention(r), 80)}: answer it yourself.` : null);
// The placard: No unless the intake says they haul hazardous material, what they haul names
// something that may need one (Progressive's reading, HAZ_HAUL: fuel, propane, chemicals…), or the
// notes do.
const placardMention = (r) => (r.operations.hazmat === true ? 'hazmat'
  : HAZ_HAUL.test(String(r.operations.whatHaul ?? '')) ? 'haul' : notesLine(HAZ_HAUL)(r) ? 'notes' : null);
const placardNote = (r) => (typeof r.operations.hazPlacard === 'boolean' ? null
  : { hazmat: 'The intake says they haul hazardous material but doesn\'t answer the placard question: answer it yourself.',
    haul: `What they haul (${quote(r.operations.whatHaul)}) may need a placard, but the intake doesn't answer the placard question: answer it yourself.`,
    notes: `The intake doesn't answer the placard question, and its notes say ${quote(notesLine(HAZ_HAUL)(r), 80)}: answer it yourself.` }[placardMention(r)] ?? null);

// Filings. GEICO's question excludes SR-22, FR-44 and other financial responsibility filings, so
// "which filings" naming only those is the agent's. Federal liability is BMC-91, MCS-90 or a federal
// liability filing; "federal" alone is one only when no cargo filing is named (BMC-34 / BMC-32
// aren't liability, and "Federal BMC-34" is cargo), else whether one is needed is the agent's. State
// is a state or intrastate filing.
const which = (r) => String(r.operations.filingsWhich ?? '');
const ONLY_FR = /^\s*(?:sr[\s-]?22|fr[\s-]?44)(?:\s*(?:,|\/|&|and)\s*(?:sr[\s-]?22|fr[\s-]?44))*\s*$/i;
const FED_LIAB = /\bbmc[\s-]?91x?\b|\bmcs[\s-]?90\b|\bfederal\s+liab/i;
const CARGO_FILING = /\bbmc[\s-]?3[24]\b|\bcargo\b/i;
const STATE_FILING = /\bstate\b|\bintrastate\b/i;
// true, false, or null when "federal" may be the cargo filing.
const federalLiability = (text) => (FED_LIAB.test(text) ? true : /\bfederal\b/i.test(text) ? (CARGO_FILING.test(text) ? null : true) : false);
// An NTL quote has no filings (TNI, 2026-10-26, W44-28: "filings not added if its NTL, in every
// case"): Neither, No, and no Add Filings box ticked, whatever the intake asks; the intake's own No
// stays the intake's.
const ntlNoFilings = (r) => ntlNoDotFilings(r) && r.operations.filingsRequired !== false;
const filingType = (r) => {
  const f = r.operations.filingsRequired;
  if (f === false || ntlNoDotFilings(r)) return 'Neither';
  if (f !== true || !which(r) || ONLY_FR.test(which(r))) return null;
  const federal = federalLiability(which(r));
  if (federal == null) return null;
  const state = STATE_FILING.test(which(r));
  return federal && state ? 'Both' : federal ? 'Federal' : state ? 'State' : null;
};
const filingTypeNote = (r) => {
  if (filingType(r) != null) return null;
  const f = r.operations.filingsRequired;
  if (f !== true) return 'The intake doesn\'t say whether filings are needed: answer it yourself.';
  if (!which(r)) return 'The intake says filings are needed but not which: answer it yourself.';
  return ONLY_FR.test(which(r)) ? `The intake names only ${quote(which(r), 40)}, which GEICO doesn't count as a filing here: answer it yourself.`
    : CARGO_FILING.test(which(r)) ? `The intake's filings (${quote(which(r), 40)}) name a cargo filing, which isn't a liability filing: whether a federal liability filing is needed is yours to answer.`
      : `The intake's filings (${quote(which(r), 40)}) don't say state or federal: answer it yourself.`;
};
// The Add Filings boxes: ticked when the intake names that filing; otherwise left as the page has
// them (never unticked: a box no filing names isn't a No).
const filingBoxes = (r) => (!ntlNoDotFilings(r) && r.operations.filingsRequired === true && which(r) && !ONLY_FR.test(which(r))
  ? { federal: federalLiability(which(r)) || null, state: STATE_FILING.test(which(r)) || null } : { federal: null, state: null });
// Whether proof of insurance or filings go to an agency: the intake's Yes or No; blank, TNI's No
// (W43-34) unless the intake names filings or a line of its notes mentions one. An SR-22 or FR-44
// (the intake's SR-22 answer, filings naming only those, a notes line naming only those) doesn't
// stop the No: GEICO's question excludes them (above).
const FILING_WORDS = /\bfilings?\b|\bbmc[\s-]?\d+|\bmcs[\s-]?90\b|\bform\s+[eh]\b/i;
const FR_FILINGS = /\b(?:sr[\s-]?22|fr[\s-]?44)(?:\s+filings?)?\b/gi;
const OTHER_FILING = { test: (s) => FILING_WORDS.test(s.replace(FR_FILINGS, ' ')) };
const filingsMention = (r) => (which(r) && !ONLY_FR.test(which(r)) ? 'which' : notesLine(OTHER_FILING)(r) ? 'notes' : null);
const hasFilings = noUnless((r) => r.operations.filingsRequired, filingsMention);
const filingsNote = (r) => {
  const f = r.operations.filingsRequired;
  if (ntlNoDotFilings(r)) return null;
  if (f === true && ONLY_FR.test(which(r))) return `The intake names only ${quote(which(r), 40)}, which GEICO doesn't count as a filing here: answer it yourself.`;
  if (f != null) return null;
  return { which: `The intake leaves "filings required" blank but names filings (${quote(which(r), 40)}): answer it yourself.`,
    notes: `The intake leaves "filings required" blank, and its notes say ${quote(notesLine(OTHER_FILING)(r), 80)}: answer it yourself.` }[filingsMention(r)] ?? null;
};
// (TNI, 2026-10-26: answers to PR questions) NTL with primary auto liability too, or NTL mentioned
// and not answered yet: the USDOT questions (the gateway's two boxes, the USDOT number, "has a USDOT
// number") and the filings questions (filings required, the filing type, the Add Filings boxes) are
// the agent's, with a note saying why (`ntlDotFilingsHold`). Answered Yes or No, the next fill
// answers them by the rules above.
const held = (source) => (r) => (ntlDotFilingsHold(r) ? 'fact' : typeof source === 'function' ? source(r) : source);
const holdOr = (note) => (r) => ntlDotFilingsHold(r) ?? (typeof note === 'function' ? note(r) : note ?? null);

// --- Business owner ----------------------------------------------------------------------------

// The owner's names come from owner() (their driver row when found, else the owner box), never
// from drivers[0]: the FL generic run put the first driver in the owner boxes. GEICO's name boxes
// take 20 characters; a lone middle initial in the owner box is left out of the first name.
const MAX_NAME = 20;
const ownerFirst = (r) => owner(r).first?.replace(/\s+[A-Za-z]\.?$/, '') || null;
const ownerLast = (r) => owner(r).last || null;
const nameNote = (name, what) => (!name ? `The intake has no ${what}: enter it yourself.`
  : name.length > MAX_NAME ? `The ${what} is longer than GEICO's ${MAX_NAME} characters: enter it yourself.` : null);
const ownerName = (r) => [ownerFirst(r), ownerLast(r)].filter(Boolean).join(' ') || r.applicant.owner1 || null;
// The business name: the company's, else the owner's (a sole proprietor; a company box saying
// there is none, util.js companyName), as Progressive and AmWINS.
const businessName = (r) => companyName(r.applicant.name) || ownerName(r);
// The owner's own driver row, for their details (marital status; license state and CDL on the
// owner's form): the first row of the intake's driver list (TNI, 2026-10-27: answer to PR question
// V4, "The owner is always the first driver on the intake's driver list", Sr or Jr regardless:
// owner().driver, or, when the intake says the owner doesn't drive, util.js nonDrivingOwnerRow).
// TNI, 2026-10-26 (answer to PR question, T3): "GEICO's owner details (date of birth, marital status,
// license state, CDL) come from the matching driver row" (the date of birth through owner().dob).
// Each keeps the source its rule gives a driving owner's: the row's value, as derived; a blank CDL
// box is TNI's CDL standard No, as every driver's (V5, 2026-10-27: confirmed). null: the agent's.
// The owner doesn't drive by util.js ownerDrivesSaid: the box's No, unless the agent set the owner's
// row not excluded, which is the owner driving (the maintainer, 2026-10-28).
const ownerDetails = (r) => (ownerDrivesSaid(r) === false ? nonDrivingOwnerRow(r) : owner(r).driver);
// An owner fact from their driver row: none with no driver rows (the agent's, never another
// driver's).
const ownerRowNote = (what) => (r) => (ownerDetails(r) ? null
  : ownerDrivesSaid(r) === false ? `The intake says the owner doesn't drive and lists no drivers, so their ${what} isn't known: answer it yourself.`
    : `The intake lists no drivers, so the owner's ${what} isn't known: answer it yourself.`);
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
// The owner's date of birth (owner().dob: the first driver row's, whatever its name: TNI,
// 2026-10-27, answer to PR question V4; before, the row the owner's name matched, never another
// driver's: TNI, 2026-10-20), as on Progressive and AmWINS, with their note when there is none. With
// no driver rows and a blank owner box, their note would quote the name as "".
const noOwnerName = (r) => !String(r.applicant.owner1 ?? '').trim();
const ownerDobNote = (r) => (!owner(r).dob && !owner(r).dobDriver && ownerDrivesSaid(r) !== false && noOwnerName(r)
  ? 'The intake has no owner name, so no driver row gives their date of birth: enter it yourself.' : noOwnerDob(r))
  ?? (!DATE.test(owner(r).dob) ? 'The owner\'s date of birth on the intake isn\'t a valid date: enter it yourself.' : null);

// Ownership type from the company name, by the rule Progressive's business structure and AmWINS'
// entity type share (util.js companyStructure, TNI 2026-10-20): the last word LLC, or Inc / Corp /
// Company; LLC inside the name with a warning; no company (none, or a box saying so) a sole
// proprietor, when the intake names the owner. Any other name (or none at all) is the agent's;
// Partnership and Trust are never guessed.
const OWNERSHIP = { llc: 'Limited Liability Company', corp: 'Corporation/Other', sole: 'Individual/Sole Proprietorship' };
const ownershipType = (r) => {
  const { structure } = companyStructure(r.applicant.name);
  return structure === 'sole' && !String(r.applicant.owner1 ?? '').trim() ? null : OWNERSHIP[structure] ?? null;
};
const ownershipNote = (r) => (ownershipType(r) != null ? null
  : companyName(r.applicant.name) ? companyStructureNote(r.applicant.name) : 'The intake has no company or owner name: answer it yourself.');
const ownershipWarn = (r) => companyStructureWarn(r.applicant.name);

// The intake's phone, in GEICO's phone boxes (owner and business, and the owner's mobile phone on
// Add Driver: W43-29, PA live run, 2026-10-21); a number that isn't a 10-digit US number stays the
// agent's.
const phoneNote = (r) => (r.applicant.phone && !/^\(\d{3}\) \d{3}-\d{4}$/.test(r.applicant.phone) ? 'The intake\'s phone isn\'t a 10-digit number: enter it yourself.' : null);

// The business street: the intake's address typed whole (street, city, state and ZIP; the unit has
// boxes of its own), and GEICO's suggestion for it picked: one with the intake's house number and
// ZIP (pagekit address-suggest; FL live run 3, 2026-10-21: the street was the agent's while GEICO's
// list had never been seen open). No such suggestion: the street alone is left in the box, for the
// agent to pick from GEICO's list. A street GEICO already shows (from the USDOT record) is kept
// when it has the intake's house number, and flagged as differing when not (`checkNumber`).
const streetLine = (r) => {
  const g = r.garaging ?? {};
  const { street } = streetParts(r);
  return street ? [street, g.city, [g.state, zip5(r) ?? g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : null;
};
const streetNote = (r) => (r.garaging?.street ? null : 'The intake has no street: enter the business address yourself.');
// What GEICO's USDOT record must show to be the client's business (W43-24): the intake's house
// number, every word of its street's name (each word up to a unit, such as Apt or Suite, that isn't a
// direction or a street type: "Avenue of the Americas" is of, the and Americas, never "of" alone)
// and ZIP. None without all three.
const STREET_WORDS_SKIPPED = /^(?:n|s|e|w|ne|nw|se|sw|north|south|east|west|st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|hwy|highway|pkwy|parkway|pl|place|ter|terrace|cir|circle)$/i;
const recordWords = (r) => {
  const m = String(r.garaging?.street ?? '').trim().match(/^(\d+[a-z]?)\s+(.+)$/i);
  const street = m?.[2].split(/\s*(?:#|\b(?:apt|apartment|suite|ste|unit)\b)/i)[0] ?? '';
  const name = street.split(/[\s.,]+/).filter((w) => w && !STREET_WORDS_SKIPPED.test(w));
  const zip = zip5(r);
  return m && name.length && zip ? [m[1], ...name, zip] : null;
};
const RECORD_NOTE = 'Check GEICO\'s USDOT record against the client\'s business, then answer it yourself.';

// The unit ("Apt 5", "Suite 200", "#12", "Lot 7", "Trlr 3", "Apt A"), as GEICO's Unit Number and Unit
// Type. Its number has a digit, or is one letter (TNI, 2026-10-21, W43-36: GA's "Apt A" was left to
// the agent, who typed A and picked Apartment). A unit without a number, or without a word naming one
// of GEICO's kinds ("#12", "Hngr 3"), is the agent's for what it lacks; no unit on the intake leaves
// both boxes as they are.
const UNIT_TYPES = { apt: 'Apartment', apartment: 'Apartment', unit: 'Unit', ste: 'Suite', suite: 'Suite', lot: 'Lot',
  bldg: 'Building', building: 'Building', rm: 'Room', room: 'Room', trlr: 'Trailer' };
const UNIT_NUMBER = String.raw`(?:[\w-]*\d[\w-]*|[a-z])`;
const UNIT_TEXT = new RegExp(String.raw`^(?:([a-z]+)(?:\.?\s*#\s*|\.\s*|\s+|(?=\d))|#\s*)?(${UNIT_NUMBER})$`, 'i');
// A street still ending in its unit, when the intake's address split didn't take it off ("1 Main St
// Apt A", W43-36): the unit goes to GEICO's boxes, and the street is typed without it, so GEICO's
// suggestion for the address still matches. Only these kinds, after a house number and a street: a
// street named like a unit ("1 Unit Rd", "100 Avenue A") stays whole. The intake's own unit wins.
const STREET_UNIT = new RegExp(String.raw`^(\d\S*\s+.*?\S)[,\s]+((?:apt|apartment|unit|ste|suite)\.?\s*#?\s*${UNIT_NUMBER}|#\s*${UNIT_NUMBER})$`, 'i');
const streetParts = (r) => {
  const street = String(r.garaging?.street ?? '').trim();
  const unit = String(r.garaging?.unit ?? '').trim();
  const m = !unit && street.match(STREET_UNIT);
  return m ? { street: m[1], unit: m[2] } : { street: street || null, unit };
};
const unitText = (r) => streetParts(r).unit;
const unitParts = (r) => {
  const m = unitText(r).match(UNIT_TEXT);
  return m ? { word: m[1] ?? null, type: m[1] ? UNIT_TYPES[m[1].toLowerCase()] ?? null : null, number: m[2] } : { word: null, type: null, number: null };
};
const noUnit = (r) => !unitText(r);
const unitNumberNote = (r) => (unitText(r) && !unitParts(r).number ? `The intake's unit ${quote(unitText(r))} has no number for GEICO's Unit Number box: enter it yourself.` : null);
const unitTypeNote = (r) => {
  const { word, type } = unitParts(r);
  if (!unitText(r) || type) return null;
  return word ? `The intake's unit ${quote(unitText(r))}: GEICO's Unit Type has no ${quote(word)}. Pick its kind yourself.`
    : `The intake's unit ${quote(unitText(r))} doesn't say which kind it is (apartment, suite, lot…): pick it yourself.`;
};

// Shown on Business & Owner Info, and again with the owner's Social Security number (OWNER_CHECK).
/** @type {CarrierRule[]} */
const OWNER_IDENTITY = [
  { field: 'GiveBusinessName', ask: 'What is the customer\'s business name?', path: 'applicant.name', name: 'Business name (company, else the owner)', source: 'derived', value: businessName },
  { field: 'GiveFirstName', ask: 'Business Owner First Name', name: 'Owner first name', source: 'derived', value: ownerFirst, note: (r) => (ownerFirst(r)?.length > MAX_NAME ? nameNote(ownerFirst(r), 'owner\'s first name') : null) },
  { field: 'GiveLastName', ask: 'Business Owner Last Name', name: 'Owner last name', source: 'derived', value: ownerLast, note: (r) => (ownerLast(r)?.length > MAX_NAME ? nameNote(ownerLast(r), 'owner\'s last name') : null) },
  { field: 'GiveDateOfBirth', ask: 'Date of Birth', name: 'Owner date of birth', kind: 'date', source: 'derived', clientFact: true, value: (r) => owner(r).dob, note: ownerDobNote },
  { field: 'GiveStreet', path: 'garaging.street', name: 'Business street (GEICO\'s suggestion for the intake\'s address)', kind: 'address-suggest', source: 'derived',
    value: streetLine, fallback: (r) => streetParts(r).street, checkNumber: true, note: streetNote },
  { field: 'GiveUnitNumber', ask: 'Unit Number', path: 'garaging.unit', name: 'Business unit number', source: 'derived', value: (r) => unitParts(r).number, ignore: noUnit, note: unitNumberNote },
  { field: 'GiveUnitType', ask: 'Unit Type', path: 'garaging.unit', name: 'Business unit type', kind: 'choice', source: 'derived', value: (r) => unitParts(r).type, ignore: noUnit, note: unitTypeNote },
  { field: 'GiveZip', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: 'Business ZIP', source: 'derived', value: zip5, note: zipNote },
  // GEICO lists the cities it knows for the ZIP and picks one; a city it doesn't list leaves GEICO's,
  // with a check naming the intake's (`keepUnlisted`; TNI, 2026-10-21, W43-35: GA listed one city and
  // OTHER, and the agent kept GEICO's).
  { field: 'GiveCity', ask: 'City', path: 'garaging.city', name: 'Business city', kind: 'choice', keepUnlisted: true },
];

// --- Vehicles and trailers ---------------------------------------------------------------------

const vehicleOf = (r, a) => r.vehicles?.[a.vehicles ?? 0] ?? null;
const trailerOf = (r, a) => r.trailers?.[a.trailers ?? 0] ?? null;
// With a VIN the decode sets year, make and model (and disables make and model): they are checked
// against the intake, never typed (a decode that differs is flagged). Without one they are typed.
const hasVin = (r, a) => !!vehicleOf(r, a)?.vin;
// GEICO's VIN decode redraws the vehicle form, clearing the type, distance and personal use given
// before it (FL live run 2, 2026-10-21: the Cascadia's Tractor was cleared three times). With a VIN,
// the form's answers wait for the decoded year (pagekit waitFor).
const afterDecode = (r, a) => (hasVin(r, a) ? 'GiveYear' : null);

const typeNote = (unit, of) => (r, a) => {
  const type = of(r, a)?.type;
  return type ? `The ${unit} type is yours to pick: the intake says ${quote(type)}.` : `The intake has no type for this ${unit}: pick it yourself.`;
};
// TNI, 2026-10-21: a cargo van (the intake's "Van", or "Cargo Van") is GEICO's Delivery Van, not
// one of its four other vans, and a Semi Truck is GEICO's Tractor. Any other type but a box truck
// (below) stays the agent's pick.
const CARGO_VAN = /^(?:cargo\s+)?van$/i;
const SEMI_TRUCK = /^semi[\s-]*truck$/i;
// TNI, 2026-10-26, W44-32 (PA live run: the agent picked Box/Straight Truck): an intake "Box Truck"
// is GEICO's Box Truck where GEICO offers one, else its Box/Straight Truck (`choiceAliases`, in order).
const BOX_TRUCK = /^box\s+truck$/i;
const vehicleType = (r, a) => {
  const type = String(vehicleOf(r, a)?.type ?? '').trim();
  return CARGO_VAN.test(type) ? 'Delivery Van' : SEMI_TRUCK.test(type) ? 'Tractor' : BOX_TRUCK.test(type) ? 'Box Truck' : null;
};
const vehicleTypeAliases = (r, a) => (vehicleType(r, a) === 'Box Truck' ? ['Box/Straight Truck'] : []);
const valueNote = (unit, of) => (r, a) => {
  const v = of(r, a)?.value;
  return v != null && typeof v !== 'number' ? `The intake's ${unit} value ${quote(v)} isn't a dollar amount: enter it yourself.` : null;
};

// Customizations (GEICO's tooltip: parts and equipment attached to the vehicle) are the intake's
// attached equipment value, one answer for all the vehicles. $0 is No for every vehicle; a value is
// Yes, and the amount itself, only with one vehicle (or trailer): with several, which one carries it
// isn't on the intake. None (blank, or one the intake reader couldn't read) is TNI's standard No
// (2026-10-21, as Progressive's and AmWINS' no-equipment standards).
// None on the intake, when a line of its notes mentions customizations or attached equipment, is
// the agent's, the line quoted, for the Yes/No and the value alike (W43-30). Ordinary freight
// wording ("hauls construction equipment") isn't one.
const severalVehicles = (r) => (r.vehicles?.length ?? 0) > 1;
const noEquipValue = (r) => r.operations?.equipVehicle == null;
const CUSTOMIZED = /\bcustomi[sz]\w*|\bcustom[\s-]+(?:built|made|parts?|equipment|work|body|bed)\b|\bmodifications?\s+(?:to|on)\s+(?:the\s+|its\s+|their\s+)?(?:truck|vehicle|van|trailer|unit)s?\b|\bmodified\s+(?:truck|vehicle|van|trailer|body|bed)s?\b|\baftermarket\b|\bupfit\w*|\b(?:attached|installed|mounted|added)\s+equipment\b|\bequipment\s+(?:attached|installed|mounted|added)\b|\bpermanently\s+attached\b/i;
const customizedNote = notesLine(CUSTOMIZED);
const customization = (r) => (r.operations?.equipVehicle === 0 ? false : noEquipValue(r) ? (customizedNote(r) ? null : false)
  : r.operations?.equipVehicle > 0 && !severalVehicles(r) ? true : null);
const customizationNote = (r) => (r.operations?.equipVehicle > 0 && severalVehicles(r)
  ? `The intake gives one attached equipment value ($${r.operations.equipVehicle.toLocaleString('en-US')}) for ${r.vehicles.length} vehicles: answer whether this vehicle has customizations yourself.`
  : noEquipValue(r) && customizedNote(r) ? `The intake has no attached equipment value, and its notes say ${quote(customizedNote(r), 80)}: answer whether this vehicle has customizations yourself.` : null);
// The customization value, wherever GEICO asks it (the vehicle and trailer forms, each vehicle on
// Quote & Coverages): the intake's equipment value. None on the intake is TNI's 0 (W43-30, TNI,
// 2026-10-21: "always 0 unless something different is mentioned in the notes"), unless a notes line
// mentions customizations (above).
const noValueNote = (unit) => (r) => (customizedNote(r) ? `The intake has no ${unit} equipment value, and its notes say ${quote(customizedNote(r), 80)}: enter it yourself.` : null);
const valueSource = (none) => (r) => (!none(r) ? 'derived' : customizedNote(r) ? 'fact' : 'standard');
const customizationValue = (r) => (r.operations?.equipVehicle === 0 ? 0
  : r.operations?.equipVehicle > 0 && (r.vehicles?.length ?? 0) === 1 ? r.operations.equipVehicle
    : noEquipValue(r) && !customizedNote(r) ? 0 : null);
const customizationValueNote = (r) => (r.operations?.equipVehicle > 0 && severalVehicles(r)
  ? `The intake gives one attached equipment value ($${r.operations.equipVehicle.toLocaleString('en-US')}) for ${r.vehicles.length} vehicles: enter this vehicle's yourself.`
  : noEquipValue(r) ? noValueNote('attached')(r) : null);
const noTrailerValue = (r) => r.trailerInfo?.equipTrailer == null;
const trailerCustomizationValue = (r) => (r.trailerInfo?.equipTrailer === 0 ? 0
  : r.trailerInfo?.equipTrailer > 0 && (r.trailers?.length ?? 0) === 1 ? r.trailerInfo.equipTrailer
    : noTrailerValue(r) && !customizedNote(r) ? 0 : null);
const trailerCustomizationNote = (r) => (r.trailerInfo?.equipTrailer > 0 && (r.trailers?.length ?? 0) > 1
  ? `The intake gives one trailer equipment value ($${r.trailerInfo.equipTrailer.toLocaleString('en-US')}) for ${r.trailers.length} trailers: enter this trailer's yourself.`
  : noTrailerValue(r) ? noValueNote('trailer')(r) : null);

// Comprehensive and collision: TNI's standard (2026-10-21) is to add them, each with a $1,000
// deductible, on every vehicle and trailer, unless the intake's notes say the client doesn't want
// physical damage ("no comp/coll", "no physical damage", "liability only"): then they are the
// agent's, with the line quoted.
const NO_PHYSICAL_DAMAGE = /\bno\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?|pd)\b|\bliability\s+only\b|\bwithout\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?)\b|\b(?:doesn'?t|does not|don'?t|do not)\s+(?:want|need)\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?)\b/i;
const noPhysicalDamage = notesLine(NO_PHYSICAL_DAMAGE);
const physicalDamageNote = (what) => (r) => (noPhysicalDamage(r) ? `The intake's notes say ${quote(noPhysicalDamage(r), 80)}: answer ${what} yourself.` : null);
const physicalDamageSource = (r) => (noPhysicalDamage(r) ? 'fact' : 'standard');
// TNI's standard coverages (src/standards.js), as GEICO's options write them.
const DEDUCTIBLE = `${usd(STANDARDS.deductible)} deductible`;
// TNI's uninsured motorist limit and pay plan on GEICO (FL live run 4, 2026-10-21: W43-17, W43-18).
// Texas lists only split limits for uninsured motorist bodily injury: there TNI's is $100,000/$300,000
// (W43-33, TNI, 2026-10-21).
const UM_SPLIT = '$100,000/$300,000';
const texas = (r) => String(r.garaging?.state ?? '').trim().toUpperCase() === 'TX';
const UM_LIMIT = `${usd(STANDARDS.umCsl)} Combined Single Limit`;
const PAY_PLAN = '11 Payments';

// Farthest one-way distance: the intake's radius in miles, as GEICO's band; long haul ("Unlimited",
// OTR, 48 states) is 501 miles, "More than 500". The FL list starts at 101-200: a band the page
// doesn't offer fails to the agent, never the lowest one offered. An open radius ("500+", "over
// 300"; the reader keeps only its number) is a lower bound: from 500 up it is "More than 500", any
// other is the agent's. Miles the agent entered on the Intake step count as written.
const miles = (r) => r.operations.radiusMiles ?? (isLongHaul(r.operations.radius) ? 501 : null);
const OPEN_RADIUS = /\d\s*\+|\b(?:over|more than|greater than|at least|beyond|above)\s+\d/i;
const openRadius = (r) => r.operations.radiusMiles != null && OPEN_RADIUS.test(String(r.operations.radius ?? ''))
  && parseRadius(r.operations.radius).miles === r.operations.radiusMiles;
const distanceBand = (r) => {
  const n = miles(r);
  if (n == null) return null;
  if (openRadius(r)) return n >= 500 ? 'More than 500' : null;
  return n <= 25 ? '0-25' : n <= 50 ? '26-50' : n <= 100 ? '51-100' : n <= 200 ? '101-200' : n <= 300 ? '201-300' : n <= 500 ? '301-500' : 'More than 500';
};
const distanceNote = (r) => (miles(r) == null && r.operations.radius ? `The intake's radius ${quote(r.operations.radius, 40)} isn't a number of miles: answer it yourself.`
  : distanceBand(r) == null && openRadius(r) ? `The intake's radius ${quote(r.operations.radius, 40)} gives only a lower bound: pick the band yourself.` : null);

// Personal use: the intake's one answer for the business. No is No for every vehicle; Yes only
// with one vehicle (with several, which one isn't on the intake).
const personalUse = (r) => (r.operations.personalUse === false ? false : r.operations.personalUse === true && (r.vehicles?.length ?? 0) === 1 ? true : null);
const personalUseNote = (r) => (r.operations.personalUse === true && (r.vehicles?.length ?? 0) > 1
  ? `The intake says vehicles are used personally but not which of the ${r.vehicles.length}: answer it for this vehicle yourself.` : null);

// Where the unit is parked: GEICO puts the business address there. Its street is left as GEICO
// has it (the box offers GEICO's own suggestions, never recorded open) and is the agent's only
// when empty; the ZIP and city are the intake's garaging ones, a different ZIP on the page kept
// and flagged.
/** @returns {CarrierRule[]} */
const parking = (unit) => [
  { field: 'GiveStreet', q: `GiveStreet.${unit}`, ask: `Where does the customer usually park their ${unit} when not in use?`, name: `Where the ${unit} is parked: street (as GEICO has it)`, ignore: true,
    emptyNote: (r) => `GEICO left where the ${unit} is parked empty: enter it yourself${r.garaging?.street ? ` (the intake's garaging street is ${quote(r.garaging.street)})` : ''}.` },
  { field: 'GiveZip', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: `Where the ${unit} is parked: ZIP`, source: 'derived', value: zip5, note: zipNote },
  // A city GEICO doesn't list for the ZIP: GEICO's kept, with a check (W43-35, as on Business & Owner Info).
  { field: 'GiveCity', ask: 'City', path: 'garaging.city', name: `Where the ${unit} is parked: city`, kind: 'choice', keepUnlisted: true },
];

// --- Drivers -----------------------------------------------------------------------------------

const driverOf = (r, a) => r.drivers?.[a.drivers ?? 0] ?? null;
// The intake driver GEICO lists itself: the owner who drives (util.js ownerDrives: a blank box is
// TNI's Yes, W44-25), their driver row the first on the intake (owner().driver; TNI, 2026-10-27:
// answer to PR question V4) (GEICO adds them on Business & Owner Info). -1 for none.
const listedDriver = (r) => (r?.applicant && ownerDrives(r) === true && owner(r).driver ? r.drivers.indexOf(owner(r).driver) : -1);
// Add Driver by itself only when GEICO's own driver rows are known: the owner doesn't drive (the
// intake's No, or their row marked excluded), or drives and is one of the intake's drivers. A blank
// "owner drives" box counts as Yes here too (TNI, 2026-10-26, W44-25; W44-01: an OH quote printed
// with one of the intake's two drivers, the box blank). The owner's row is the first, whatever its
// name (TNI, 2026-10-27: answer to PR question V4), so with any driver row GEICO's are known: GEICO
// lists the first and the fill adds the others, or, the owner not driving, the fill adds every row
// but the owner's (omittedDriver, below). This replaces the owner's row by name, which left adding
// the drivers to the agent for an owner no row's name matched, for the owner's name on several rows
// with only some excluded (the 2026-10-26 answer), and, with the intake's No, for a Sr and a Jr
// neither exactly the owner's full name (T2). No driver rows: nothing to add.
const driversKnown = (r) => ownerDrives(r) === false || listedDriver(r) >= 0;
// The intake driver GEICO's quote leaves out: the owner's row (the first: TNI, 2026-10-27, answer to
// PR question V4) when the owner doesn't drive and the row is excluded (util.js ownerExcluded):
// - the intake's No (TNI, 2026-10-26: answer to PR question, T1: GEICO "does not add the owner's row
//   at all; only the other intake drivers are added"), unless the agent set the row's Excluded driver
//   to No, which makes the owner a driver GEICO lists (util.js ownerDrivesSaid). Before, R1 had it
//   added with the other drivers and the excluded-driver warning, but GEICO asks nothing about
//   excluding a driver, so it was on the quote as one;
// - the row marked "Excluded" with the box blank or Yes (TNI, 2026-10-27: answer to PR question V3:
//   "GEICO leaves that row out too, as T1", since an excluded owner doesn't drive, R1). Before, it was
//   added with the warning (the 2026-10-20 rule, which still holds for any other excluded driver:
//   excludedWarn).
// The fill never clicks "+" for it (addUnit), nor fills an Add Driver form for it (ownerOmittedNote);
// the panel never picks it for a form (sidepanel pickUnitForm) and GEICO's driver list is complete
// without it (src/units.js unitToAdd). With no other driver, a "needs you" item holds Continue
// (noOtherDriver, V1). -1 for none.
/** @param {any} r @returns {number} */
const omittedDriver = (r) => (r?.applicant && ownerExcluded(r) ? r.drivers.indexOf(ownerRow(r)) : -1);
// The owner GEICO's quote leaves out is the intake's only driver: no driver is added. TNI, 2026-10-27
// (answer to PR question V1): the agent's, with a "needs you" item that holds Continue (the action
// noOtherDriver).
const noOtherDriver = (r) => omittedDriver(r) >= 0 && r.drivers.length === 1;
// What the driver list says of an intake driver it doesn't have that no helper adds (the panel,
// src/units.js unitMissing; W44-01, OH 2026-10-26: "owner drives" blank, the quote printed with the
// owner alone and the panel silent). With a blank box TNI's Yes (W44-25) and the owner's row the first
// (V4), GEICO's own driver rows are known whenever the intake has a driver (driversKnown), so the
// extension adds the driver once the panel has them picked (the picker stays where it was until a form
// is read on this page). The owner's row GEICO's quote leaves out (omittedDriver) is never named: it is
// no unit of the list (src/units.js unitToAdd).
const driverMissing = (r, list, i) => {
  const d = r.drivers?.[i];
  const who = [d?.first, d?.last].filter(Boolean).join(' ') || `Driver ${i + 1}`;
  return `${who} (driver ${i + 1} of the intake) isn't on GEICO's driver list: pick them in the panel and Fill again, or add them with "+" yourself.`;
};
// An Add Driver form while the panel's driver is the owner, whom GEICO already lists as a driver
// (Business & Owner Info: the owner drives): filling it would add the owner twice. The panel's
// picker starts on the first driver, the owner.
const ownerListedNote = (r, a) => (ownerDrives(r) && !!owner(r).driver && owner(r).driver === driverOf(r, a)
  ? 'The panel\'s driver is the owner, whom GEICO already lists: pick the driver this form is for in the panel, then Fill again.' : null);
// The same while the panel's driver is the owner's row GEICO's quote leaves out (omittedDriver: T1, V3).
const ownerOmittedNote = (r, a) => (!!driverOf(r, a) && (a.drivers ?? 0) === omittedDriver(r)
  ? 'The panel\'s driver is the owner, who doesn\'t drive (the intake), and GEICO\'s quote leaves them out (TNI): pick the driver this form is for in the panel, then Fill again.' : null);
const driverNote = (more) => (r, a) => ownerListedNote(r, a) ?? ownerOmittedNote(r, a) ?? (more ? more(r, a) : null);
// "What is their relationship to the business?": Owner for a driver who is one of the intake's
// owners; any other driver is TNI's standard Employee (2026-10-21). The owner's row is the first
// (TNI, 2026-10-27: answer to PR question V4); a later row is an employee, even with the owner's name
// (a Jr). A row the owner box's second name matches (owner2, a co-owner) is still Owner, by name.
const isOwner = (r, d) => !!d && (d === ownerRow(r) || ownerIsDriver(r.applicant.owner2, d));
const relationship = (r, a) => (!driverOf(r, a) ? null : isOwner(r, driverOf(r, a)) ? 'Owner' : 'Employee');
const relationshipSource = (r, a) => (driverOf(r, a) && !isOwner(r, driverOf(r, a)) ? 'standard' : 'derived');
const relationshipNote = (r, a) => (relationship(r, a) ? null : 'The intake has no driver for this form: answer it yourself.');
// SR-22: the intake's one answer for the business. No is No for every driver; Yes only when GEICO
// lists one driver: on the owner's form, the owner matched to the intake's only driver; on Add
// Driver, the intake's only driver when the owner doesn't drive (since V4 that row is the owner's,
// left out, unless the agent set its Excluded driver to No). Otherwise (several drivers, or the
// owner listed besides the intake's driver) which one needs it isn't on the intake. Blank is TNI's
// No for every driver (W43-34, 2026-10-21), unless the intake's filings or notes name an SR-22, an
// FR-44 or financial responsibility: then the agent's, quoted.
const onlyDriver = (r) => ((r.drivers?.length ?? 0) === 1 ? r.drivers[0] : null);
const SR22 = /\bsr[\s-]?22\b|\bfr[\s-]?44\b|\bfinancial\s+responsibility\b/i;
const sr22Mention = (r) => (SR22.test(which(r)) ? which(r).trim().slice(0, 80) : notesLine(SR22)(r));
const sr22 = (yes) => (r) => (r.operations.needSr22 === false ? false : r.operations.needSr22 === true ? (yes(r) ? true : null) : sr22Mention(r) ? null : false);
const sr22Source = (r) => (typeof r.operations.needSr22 === 'boolean' ? 'derived' : sr22Mention(r) ? 'fact' : 'standard');
const sr22Owner = sr22((r) => !!onlyDriver(r) && owner(r).driver === onlyDriver(r));
const sr22Driver = sr22((r) => !!onlyDriver(r) && ownerDrives(r) === false);
const sr22Note = (value) => (r) => (r.operations.needSr22 == null ? (sr22Mention(r) ? `The intake doesn't answer the SR-22 question but mentions ${quote(sr22Mention(r), 80)}: answer it for this driver yourself.` : null)
  : r.operations.needSr22 !== true || value(r) != null ? null
    : (r.drivers?.length ?? 0) > 1 ? `The intake says an SR-22 is needed but not for which of the ${r.drivers.length} drivers: answer it for this driver yourself.`
      : 'The intake says an SR-22 is needed but not for which of the drivers GEICO lists (the owner and the intake\'s driver): answer it for this driver yourself.');
// A driver to be excluded (util.js driverExcluded): GEICO asks nothing about it, so the form is
// filled with a warning (TNI, 2026-10-20). The owner's row the quote leaves out (the intake's No, or
// the owner's row marked Excluded: omittedDriver, T1 and V3; before, R1 and the 2026-10-20 rule
// warned it here) isn't added at all: its form carries ownerOmittedNote instead.
const excludedWarn = (r, a) => {
  const d = driverOf(r, a);
  if (!d || (a.drivers ?? 0) === omittedDriver(r)) return null;
  return driverExcluded(r, d) ? 'The intake marks this driver to be excluded, and GEICO asks nothing about it here: handle the exclusion yourself.' : null;
};
const dobNote = (r, a) => (driverOf(r, a)?.dob && !DATE.test(driverOf(r, a).dob) ? 'This driver\'s date of birth on the intake isn\'t a valid date: enter it yourself.' : null);

// --- Additional business info ------------------------------------------------------------------

// "How many years has this business been operating?" from the intake's years in business (this
// year minus the year established). None is the agent's: AmWINS' New Venture standard is AmWINS'.
const startBucket = (n) => (!Number.isInteger(n) || n < 0 ? null
  : n < 1 ? 'Less than 1' : n === 1 ? '1' : n === 2 ? '2' : n <= 6 ? '3-6' : '7+');

// "Does the customer currently have personal or commercial auto insurance?" Yes for a current auto
// policy on the intake (commercial or personal, with an expiration date not passed; derived), No for
// no prior insurance. Yes too, TNI's assumption, when any other box of an auto or untyped policy is
// filled: an undated policy, a remark in the date box, a carrier or limit alone (TNI, 2026-10-26,
// W44-29, W44-12: proof of prior insurance; the Intake step names the blank boxes). A blank
// section, an expired policy, or a GL / cargo / other row is the agent's; "deployed" is never
// derived.
const AUTO = /^(commercial|personal)\s+auto$/i;
const datedAuto = (r) => { const p = prior(r); return !!p && AUTO.test(String(p.type ?? '').trim()) && DATE.test(p.expiration ?? '') && !priorPolicyExpired(r, p); };
const currentAuto = (r) => {
  const p = prior(r);
  if (!p) return null;
  if (noPriorInsurance(p)) return 'No';
  return datedAuto(r) || priorInsuranceAssumed(r) ? 'Yes' : null;
};
const currentAutoSource = (r) => (currentAuto(r) === 'Yes' && !datedAuto(r) ? 'standard' : 'derived');
// "How many employees does the customer's business have…?" TNI (2026-10-21): the intake's drivers
// other than the owner(s), as GEICO's band. No drivers on the intake is the agent's.
const employees = (r) => {
  if (!r.drivers?.length) return null;
  const n = r.drivers.filter((d) => !isOwner(r, d)).length;
  return n === 0 ? 'None' : n === 1 ? '1' : n <= 3 ? '2-3' : n <= 5 ? '4-5' : n <= 10 ? '6-10' : n <= 20 ? '11-20' : '21+';
};
// "How long has the customer been with their current auto insurance company?" TNI (2026-10-21;
// 2026-10-26, W44-29, W44-02: "1-3 years at least"): 1-3 Years whenever the customer currently has
// auto insurance (above), also when the notes say the policy started within the year. A longer
// time the notes give (insurerTenure) isn't shortened: its band (TNI, 2026-10-26: answer to PR
// question; the Intake step quotes the line, `prior.tenure`). A time on a band edge takes the upper
// band: exactly 5 years is 5-10, exactly 10 or "10+" is 10+ (TNI, 2026-10-26: answer to PR
// question, round 2, R5; until then the agent's). Exactly 3 stays 1-3, the decision's "1-3 at
// least". A time two bands could fit ("since 2021" in 2026: 4.7 to 5.7 years) stays the agent's,
// with the line quoted. Hedges read as their words, ">5" and "5 plus" as over 5, "~5" and "5ish"
// as 5, "<5" as under 5 (TNI, 2026-10-27: answer to PR question, round 5, V6); a range ("3-5
// years") is a band only when both ends fall in it, "6-8 years" 5-10 Years (TNI, 2026-10-27:
// answer to PR question, round 5, V7).
const GEICO_TENURE = (n) => (n <= 3 ? '1-3 Years' : n < 5 ? '3-5 Years' : n < 10 ? '5-10 Years' : '10+ Years');
const longerTenure = (r) => { const t = insurerTenure(r); return t && t.years > 3 ? t : null; };
const yearsWithInsurer = (r) => {
  if (currentAuto(r) !== 'Yes') return null;
  const t = longerTenure(r);
  return t ? tenureBand(t, GEICO_TENURE) : '1-3 Years';
};
const yearsSource = (r) => (!yearsWithInsurer(r) ? 'fact' : longerTenure(r) ? 'derived' : 'standard');
const anyPriorBox = (p) => !!p && ['type', 'carrier', 'limit', 'expiration'].some((k) => p[k] != null && String(p[k]).trim() !== '');
const currentAutoNote = (r) => (currentAuto(r) != null ? null
  : !anyPriorBox(prior(r)) ? 'The intake\'s current insurance section is blank: answer it yourself.'
    : priorPolicyExpired(r, prior(r)) ? 'The intake\'s current policy has expired: answer it yourself.'
      : `The intake's current insurance is ${prior(r).type ? quote(prior(r).type, 30) : 'another kind of policy'}, not an auto policy: answer it yourself.`);
const yearsNote = (r) => (yearsWithInsurer(r) ? null
  : currentAuto(r) === 'Yes' ? `The intake's notes give the time with the current insurer (${quote(longerTenure(r)?.line, 80)}), and more than one of GEICO's bands could fit it: pick it yourself.`
    : currentAutoNote(r) ?? 'The intake shows no current auto policy: answer it yourself.');
// The current bodily injury limits, from the intake's limit, when there is a current auto policy:
// each intake option to GEICO's, exactly. $500K/$1M and Other have no GEICO match; none is "closest".
const BI_LIMITS = {
  'State Minimum': 'State Minimum',
  '$25K/$50K': '$25,000/$50,000 or $50,000 CSL',
  '$50K/$100K': '$50,000/$100,000',
  '$100K/$300K': '$100,000/$300,000',
  '$100K CSL': '$100,000/$100,000 or $100,000 CSL',
  '$300K CSL': '$300,000/$300,000 or $300,000 CSL',
  '$250K/$500K': '$250,000/$500,000',
  '$750K CSL': '$750,000/$750,000 or $750,000 CSL',
  '$1M CSL': '$1,000,000/$1,000,000 or $1,000,000 CSL',
};
const currentBi = (r) => (currentAuto(r) === 'Yes' ? BI_LIMITS[String(prior(r).limit ?? '').trim()] ?? null : null);
const currentBiNote = (r) => (currentBi(r) != null ? null
  : currentAuto(r) === 'Yes' && prior(r).limit ? `The intake's current limit ${quote(prior(r).limit, 30)} has no exact match in GEICO's list: pick it yourself.`
    : currentAuto(r) === 'Yes' ? 'The intake\'s current insurance has no limit: answer it yourself.'
      : 'The intake has no current auto policy limit GEICO lists: answer it yourself.');
// "What kind of liability insurance does the customer currently have to cover their business?" GL
// for a current general liability policy on the intake. You marking that the client has GL
// (coverage.hasGl) doesn't say GL or a business owner's policy: the agent's. Otherwise TNI's
// standard None (2026-10-21, as Progressive's other business coverages): a GL request
// (coverage.gl) is not GL they have.
const currentGl = (r) => {
  const p = prior(r);
  return !!p && /general\s+liability/i.test(p.type ?? '') && !noPriorInsurance(p) && DATE.test(p.expiration ?? '') && !priorPolicyExpired(r, p);
};
const otherLiability = (r) => (currentGl(r) ? 'General Liability Policy (GL)' : r.coverage?.hasGl === true ? null : 'None');
const otherLiabilitySource = (r) => (currentGl(r) ? 'derived' : r.coverage?.hasGl === true ? 'fact' : 'standard');
const otherLiabilityNote = (r) => (r.coverage?.hasGl === true && !currentGl(r) ? 'You marked that the client has general liability: pick GL or a business owner\'s policy yourself.' : null);

// --- Quote & Coverages -------------------------------------------------------------------------

// Non-trucking liability mentioned in the claims box or notes and not yet answered: GEICO's
// liability coverage and its limit are the agent's until they answer it on the Intake step.
// (`ntlUndecided` in normalize.js: the claims box, the notes or Luna's flag; it holds the USDOT and
// filings questions too.)
const ntlQuote = (r) => r.coverage?.ntl === true;
const ntlNote = (r) => (ntlUndecided(r) ? 'The claims box or notes mention non-trucking liability: set it to Yes or No on the Intake step, then fill this page again.' : null);
// "Liability Coverage": Non-Trucking Liability on an NTL quote (the maintainer, 2026-10-26, live run:
// GEICO then asks "under permanent lease?", answered Yes by ntlLease, and draws its NTL limit);
// Bodily Injury and Property Damage Liability for an intake asking for auto liability (Yes, or a
// limit with the box blank). No, or nothing is the agent's; "I don't need Liability Coverage" is
// never picked.
const liabilityType = (r) => {
  const a = String(r.coverage?.autoLiability ?? '').trim();
  if (ntlQuote(r)) return 'Non-Trucking Liability';
  if (ntlNote(r) || /non-?trucking/i.test(a) || /^no$/i.test(a)) return null;
  return /^yes$/i.test(a) || (!a && r.coverage?.autoLiabLimit) ? 'Bodily Injury and Property Damage Liability' : null;
};
const liabilityNote = (r) => ntlNote(r) ?? (liabilityType(r) ? null
  : /non-?trucking/i.test(r.coverage?.autoLiability ?? '') ? 'The intake asks for non-trucking liability: pick GEICO\'s liability coverage yourself.'
    : /^no$/i.test(String(r.coverage?.autoLiability ?? '').trim()) ? 'The intake says no auto liability: answer it yourself.'
      : 'The intake doesn\'t say which liability coverage: answer it yourself.');

// Medical Payments and PIP (TNI, 2026-10-26, W44-26; the maintainer: "Always add medical payments
// at $5K, there is no medical payments, choose PIP"; GEICO offering both: "MedPay $5K, PIP yok"),
// replacing that morning's "If there is personal injury protection available, we always prefer PIP"
// and, in Florida, the 2026-10-21 Medical Payments Not Included. In every state Medical Payments is
// $5,000 where GEICO lists limits for it (a list without $5,000 is the agent's at once), and Not
// Included where its only choice is Not Included (GEICO offers none: the TX live run). Outside
// Florida, Basic Personal Injury Protection is GEICO's "I decline" where Medical Payments lists a
// limit, and $2,500 where it lists none or isn't on the page; a list without that answer is the
// agent's at once (one without "I decline" beside medical payments: PIP may be required there).
// Florida requires PIP: its PIP lists (one choice each) are kept as GEICO has them. The other PIP
// lists are the agent's elsewhere.
const MED_PAY = usd(STANDARDS.medPay);
const MED_PATH = 'geico.qMedicalPayments';
const florida = (r) => String(r.garaging?.state ?? '').trim().toUpperCase() === 'FL';
const pipKept = (name) => ({ ignore: florida, source: (r) => (florida(r) ? null : 'fact'),
  emptyNote: `GEICO left ${name} empty: pick it yourself.` });

// Refrigeration breakdown: the intake's Yes or No. Left blank, TNI's standard (2026-10-21): Yes when
// the intake lists a reefer (a refrigerated vehicle or trailer), else No. An intake No with a reefer
// listed is the agent's.
const REEFER = /\breefer\b|\brefrigerat/i;
const hasReefer = (r) => [...(r.vehicles ?? []), ...(r.trailers ?? [])].some((u) => REEFER.test(String(u?.type ?? '')));
const reeferBreakdown = (r) => (typeof r.coverage?.reeferBreakdown !== 'boolean' ? hasReefer(r)
  : r.coverage.reeferBreakdown || !hasReefer(r) ? r.coverage.reeferBreakdown : null);
const reeferSource = (r) => (typeof r.coverage?.reeferBreakdown !== 'boolean' ? 'standard' : reeferBreakdown(r) == null ? 'fact' : 'intake');
const reeferNote = (r) => (reeferSource(r) === 'fact' ? 'The intake says no reefer breakdown but lists a reefer: answer it yourself.' : null);

// Motor truck cargo: the intake's limit and deductible as GEICO's pair ("$100k/$1000 deductible",
// matched by its amounts). No deductible on the intake is the agent's alone, never Luna's, as on
// every carrier (noCargoDeductible). A pair GEICO doesn't list ($100K/$5K) finds no option and stays the agent's.
const cargoChoice = (r) => (r.coverage?.cargo === true && r.coverage.cargoLimit && r.coverage.cargoDeductible
  ? `$${r.coverage.cargoLimit}/$${r.coverage.cargoDeductible}` : null);
const cargoLimitSource = (r) => (r.coverage?.cargo === true && noCargoDeductible(r) ? 'fact' : 'derived');
const cargoLimitNote = (r) => (cargoChoice(r) ? null
  : r.coverage?.cargo === true && noCargoDeductible(r) ? CARGO_DEDUCTIBLE_NOTE
    : r.coverage?.cargo === true ? 'Cargo is requested without both a limit and a deductible on the intake: choose them yourself.'
    : 'The intake doesn\'t ask for cargo coverage: answer it yourself.');
const cargoNote = (r) => (typeof r.coverage?.cargo !== 'boolean' && r.coverage?.cargoLimit
  ? 'The intake gives a cargo limit but doesn\'t tick cargo coverage: answer it yourself.' : null);
const isMover = (r) => /^household\s+goods\s+mover$/i.test(String(r.operations.businessClass ?? '').trim());
// Household goods or cotton ginned within 72 hours: Yes for a household goods mover; otherwise TNI's
// No (W43-30, 2026-10-21: "default No unless business type, commodities or notes mention household
// moving"), unless the business class, what they haul or a line of the notes mentions household
// goods, household moving (a home, residential or office move, a moving company) or cotton: then the
// agent's, quoted. Freight that "keeps moving", or a "prime mover", isn't household moving.
const HOUSEHOLD = /\bhousehold\b|\b(?:home|house|residential|apartment|office|furniture)\s+(?:mov(?:e|es|ers?|ing)|relocations?)\b|\bmoving\s+(?:company|companies|services?|business)\b|\bcotton\b|\bginn(?:ed|ing)\b/i;
const householdMention = (r) => (HOUSEHOLD.test(freightWords(r)) ? freightWords(r) : notesLine(HOUSEHOLD)(r));
const household = (r) => (isMover(r) ? true : householdMention(r) ? null : false);
const householdSource = (r) => (isMover(r) ? 'derived' : householdMention(r) ? 'fact' : 'standard');
const householdNote = (r) => (!isMover(r) && householdMention(r) ? `The intake mentions household goods, household moving or cotton (${quote(householdMention(r), 80)}): answer it yourself.` : null);

// Motor truck cargo (TNI, FL live run 5, 2026-10-21, W43-23). What the intake says about the freight:
// its business class and what they haul.
const freightWords = (r) => [r.operations.businessClass, r.operations.whatHaul].filter(Boolean).join(' / ');
// Mobile homes, business documents or securities, and live animals: TNI's No, unless the intake names
// them (whole words: "pigments" names no pigs), when they are the agent's.
const MOBILE_HOMES = /\b(?:mobile\s*homes?|modular\s*(?:homes?|buildings?)|business\s*documents?|securities)\b/i;
const LIVE_ANIMALS = /\b(?:live\s*animals?|livestock|cattle|horses?|hogs?|pigs?|sheep|goats?)\b/i;
const cargoNo = (words, what) => ({
  source: (r) => (words.test(freightWords(r)) ? 'fact' : 'standard'),
  value: (r) => (words.test(freightWords(r)) ? null : false),
  note: (r) => (words.test(freightWords(r)) ? `The intake mentions ${what} (${quote(freightWords(r), 80)}): answer it yourself.` : null),
});
// The commodities, GEICO's option texts joined by "; " (a list taking several): a reefer (one
// listed, or the freight refrigerated) hauls pharmaceuticals, food and beverages, dairy and frozen
// seafood; an auto hauler automobiles; car or auto parts auto accessories (not tires); general
// freight (General Freight Hauler, Consumer Goods, General Freight, Dry Freight, General) other
// consumer goods, as on Progressive (cargoCommodity in util.js). The first match only, so freight
// naming car parts and general freight is auto accessories, as on Progressive; car parts named with
// tires or cars themselves are the agent's (carPartsMixed). No match: null.
const COMMODITIES = [
  { test: (r) => hasReefer(r) || /reefer|refrigerat/i.test(freightWords(r)),
    picks: ['Consumer Goods - Pharmaceuticals (Over The Counter)', 'Food & Beverage - Other Food & Beverages', 'Refrigerated Goods - Dairy', 'Refrigerated Goods - Frozen Seafood'] },
  // Car parts with tires or cars themselves: the agent's, on every carrier (TNI, 2026-10-28).
  { test: carPartsMixed, picks: [] },
  // Cars themselves, never their parts or accessories (CARS in util.js).
  { test: (r) => CARS.test(freightWords(r)), picks: ['Aircraft/Auto/Boats - Automobiles'] },
  // Car or auto parts: TNI's auto accessories (TNI, 2026-10-28, on every carrier; before, general
  // freight when named with it, else the agent's).
  { test: haulsCarParts, picks: ['Aircraft/Auto/Boats - Auto Accessories (Not Tires)'] },
  // What they haul wins over the class, as on Progressive and AmWINS (haulsGeneralFreight).
  { test: (r) => haulsGeneralFreight(r) || /freight\s*haul|consumer\s*goods|dry\s*freight|^\s*general\s*$/i.test(hauled(r)),
    picks: ['Consumer Goods - Other Consumer Goods'] },
];
// What they haul, or, left blank, the business class.
const hauled = (r) => String(r.operations.whatHaul ?? '').trim() || String(r.operations.businessClass ?? '');
const commodities = (r) => COMMODITIES.find((c) => c.test(r))?.picks.join('; ') || null;

// Motor truck general liability: the intake's GL request (util.js glRequested: coverage.gl, never
// coverage.hasGl, GL the client already has), and its limit when GEICO lists it. TNI's $1M/$2M
// default for a request without a limit is recorded for Progressive only. Its four trucking
// questions are TNI's for every carrier (util.js glAnswer, GL_OIL_GAS: TNI, 2026-10-28).
const GL_LIMITS = { '$1M/$2M': '$1,000,000/$2,000,000 aggregate' };
const glLimit = (r) => (glRequested(r) ? GL_LIMITS[String(r.coverage.glLimit ?? '').trim()] ?? null : null);
const glLimitNote = (r) => (glLimit(r) ? null
  : !glRequested(r) ? 'The intake doesn\'t ask for general liability: answer it yourself.'
    : r.coverage.glLimit ? `The intake asks for a ${quote(r.coverage.glLimit, 20)} general liability limit, which GEICO doesn't list: choose it yourself.`
      : 'General liability is requested without a limit on the intake: choose it yourself.');

// Trailer interchange the intake asks for: TNI's answers on every carrier (util.js
// interchangeRequested; the maintainer, 2026-10-28, after an FL run where the agent opened and
// answered it by hand). The limits GEICO lists (FL, 2026-10-28: $15k, $20k, $30k, $40k, $60k, $70k,
// $80k, each with a $1,000 or a $2,000 deductible, as "$60k/$1000 deductible"; no $50k): the
// intake's, else the next one up, to confirm.
const INTERCHANGE_LIMITS = [15, 20, 30, 40, 60, 70, 80].map((k) => k * 1000);
const interchangePick = (r) => interchangeLimitPick(r, INTERCHANGE_LIMITS);
const interchangeLimit = (r) => (interchangePick(r) ? `$${interchangePick(r).amount / 1000}k/$1000 deductible` : null);
// GEICO's most common trailer type for the intake's trailer type (its list, FL 2026-10-28; Dry Van
// and Flatbed the maintainer's, the others by GEICO's name for the same trailer). Enclosed, Step
// Deck and Other are the agent's pick.
const INTERCHANGE_TYPES = { 'Dry Van': 'Dry Freight Trailer', Flatbed: 'Flatbed Trailer', Reefer: 'Refrigerated Dry Freight Trailer', Lowboy: 'Lowboy Trailer', Tanker: 'Tank Trailer' };
const interchangeType = (r) => (interchangeRequested(r) ? interchangeTrailerType(r, INTERCHANGE_TYPES) : null);
const interchangeTypeNote = (r) => interchangeUnrequested(r) ?? (interchangeType(r) ? null
  : `Trailer interchange: ${interchangeTypeSaid(r, INTERCHANGE_TYPES, { carrier: 'GEICO', what: 'option' })}.`);
// Marked to confirm with the client (TNI, 2026-10-28), each on its own question: the number, the
// type, and a limit that isn't the intake's.
const interchangeCountWarn = (r) => (interchangeRequested(r) ? 'Trailer interchange: TNI\'s default of 1 non-owned trailer. Confirm it with the client.' : null);
const interchangeTypeWarn = (r) => (interchangeType(r)
  ? `Trailer interchange: ${interchangeTypeSaid(r, INTERCHANGE_TYPES, { carrier: 'GEICO', what: 'option' })}. Confirm it with the client.` : null);
// The two cards on Quote & Coverages (2026-10-28): each opens only by its chevron, as cargo's. GEICO
// names Non-Owned Trailer Physical Damage's card as trailer interchange's: its own question tells
// them apart (Chrome's :has).
const INTERCHANGE_CARD = 'li[id^="Id_TrailerInterchangeQuestionsComboActivityData_"]:has([id^="Id_GiveTrailerInterchangeEligibleRequireCoverageYesNo_"])';
const GL_CARD = 'li[id^="Id_MotorTruckGeneralLiabilityEligibilityComboActivityData_"]';
const INTERCHANGE_LIMIT = 'geico.qTrailerInterchangeLimit';
const GL_LIMIT = 'geico.qGeneralLiabilityLimit';
// What Recalculate, View More Payment Plans and Print Quote Proposal wait for (TNI, 2026-10-28): each
// card the intake asks for opened, and its limit answered (the fill's, or the agent's).
const sectionsOpened = (r) => [...(interchangeRequested(r) ? ['openInterchange'] : []), ...(glRequested(r) ? ['openGl'] : [])];
const sectionLimits = (r) => [...(interchangeRequested(r) ? [INTERCHANGE_LIMIT] : []), ...(glRequested(r) ? [GL_LIMIT] : [])];

// A vehicle's rows on Quote & Coverages, one per vehicle, by the coverage their list's id ends in:
// comprehensive and collision are TNI's $1,000 deductibles, road service accepted on every vehicle
// (emergency, and heavy vehicle on a heavy truck: TNI, FL live run 4, 2026-10-21, W43-17), the rest
// the agent's.
const ROAD_SERVICE = 'I accept this coverage';
// Fire and theft and rental reimbursement on every vehicle (TNI, FL live run 5, 2026-10-21, W43-22):
// rental needs comprehensive and collision, so it follows them (physicalDamageSource).
const FIRE_THEFT = 'Not Included';
const RENTAL = `${usd(STANDARDS.rental.perDay)} Per Day, ${usd(STANDARDS.rental.max)} Max`;
// Rental reimbursement with downtime: TNI's Not Included on every vehicle (W43-30, 2026-10-21: "always
// No"), unless a line of the intake's notes mentions downtime or rental: then the agent's, quoted.
const DOWNTIME = 'Not Included';
const downtimeMention = notesLine(/\bdown[\s-]*time\b|\brental\b/i);
const downtimeNote = (r) => (downtimeMention(r) ? `The intake's notes say ${quote(downtimeMention(r), 80)}: answer rental reimbursement with downtime yourself.` : null);
const ROW_COVERAGES = [['COMP', 'Comprehensive'], ['COLL', 'Collision'], ['FT', 'Fire and theft'], ['Rental', 'Rental reimbursement'],
  ['RRWDT', 'Rental reimbursement with downtime'], ['ERS', 'Emergency road service'], ['HVRS', 'Heavy vehicle road service']];
// What a vehicle's row needs on that vehicle before GEICO offers its answers (`needs`): collision
// lists only Not Included until comprehensive (or fire and theft) is chosen, and rental and road
// service say "Comprehensive or fire & theft, and collision coverage are required before adding this
// coverage". TNI's fire and theft is Not Included, so comprehensive is the one the fill gives. A
// comprehensive the page didn't keep (GEICO live run, 2026-10-28: the Sprinter's, on a slow page) is
// then one needs-you item for the vehicle, not a failure for each row behind it.
const ROW_NEEDS = { COLL: ['COMP'], Rental: ['COMP', 'COLL'], RRWDT: ['COMP', 'COLL'], ERS: ['COMP', 'COLL'], HVRS: ['COMP', 'COLL'] };
/** @param {CarrierRule} rule @returns {CarrierRule} */
const withNeeds = (rule) => (ROW_NEEDS[rule.q] ? { ...rule, needs: ROW_NEEDS[rule.q] } : rule);

// --- Adding units --------------------------------------------------------------------------------

// The unit the panel is adding (`adding`, sidepanel pickUnitToAdd): the intake's next vehicle, then
// trailer, not on the quote yet on Vehicles, the next driver on Drivers & Incidents; its index is
// the picker's (a[list]). `click`: the panel's "Fill the pages" or "Click Continue when the page is
// done" is on (W43-20), and the fill clicks the helpers below for it; both off, it only answers the
// chooser.
const adds = (list) => (r, a) => !!a.adding?.click && a.adding.list === list && a.adding.index === (a[list] ?? 0);
// The chooser's answer for it: Vehicle or Trailer (null on the driver list, or with none to add).
const chosen = (r, a) => ({ vehicles: 'Vehicle', trailers: 'Trailer' })[a.adding?.list] ?? null;
// The Motor Truck Cargo card on Quote & Coverages (W43-16).
const CARGO_CARD = 'li[id^="Id_MtcCoverageQuestionsComboActivityData_"]';
const UNIT = { vehicles: ['vehicle', 'Vehicle'], trailers: ['trailer', 'Trailer'], drivers: ['driver', 'Driver'] };
// Each helper is per unit (its id ends in the unit's index), clicked once a quote: a unit is never
// added twice. The "+" counts once a question shows (the chooser, Add Driver's form), the chooser's
// Next once the unit's form does. A "+" clicked for a unit that got no form, and isn't on the list
// (the chooser cancelled), is the agent's: the list says so (`unfinished`).
/** @returns {CarrierAction} */
const addUnit = (list, listSelector, how) => ({
  id: `add${UNIT[list][1]}`, steps: [list === 'drivers' ? DRIVERS : VEHICLES], token: 'addIcon', within: `${listSelector} > li.add-state`,
  loads: true, verify: 'revealed', scope: UNIT[list][0], label: list === 'drivers' ? 'Add Driver' : 'Add Vehicle or Trailer',
  // A driver only while GEICO's drivers are known, and never the owner's row its quote leaves out
  // (omittedDriver: TNI, 2026-10-26 and 2026-10-27, answers to PR questions T1 and V3), whatever the
  // panel picked.
  when: (r, a) => adds(list)(r, a) && (list !== 'drivers' || (driversKnown(r) && a.adding.index !== omittedDriver(r))),
  doneWhen: (r, a) => [`${UNIT[list][0]}Entered:${a[list] ?? 0}`],
  unfinished: (r, a) => `The "+" was clicked for ${UNIT[list][0]} ${(a[list] ?? 0) + 1} of the intake, but no form was filled for it and it isn't on the list: add it yourself (${how}), then fill.`,
});
// The chooser's Next, once its answer is in, whoever clicked "+" (W43-14, TNI 2026-10-21: after the
// agent's own "+", the fill answered the chooser and held its Next for a "+" of its own that never
// came). An answer the agent changed there is theirs, and stays (the fill skips their edits).
/** @returns {CarrierAction} */
const chooseUnit = (list) => ({
  id: `choose${UNIT[list][1]}`, steps: [VEHICLES], text: '^next$', within: CHOOSER_BUTTONS, moveOn: true,
  loads: true, verify: 'revealed', after: ['geico.qGiveVehicleOrTrailer'],
  scope: UNIT[list][0], when: adds(list),
});

// A rule without a record path is named by its data-model name (its path geico.q<name>, which
// logs and reviews read), with a suffix where one name is two questions.
/** @param {CarrierRule[]} rules @returns {CarrierRule[]} */
const named = (rules) => rules.map(/** @returns {CarrierRule} */ (rule) => (rule.path || rule.q || !rule.field ? rule : { ...rule, q: rule.field }));

/** @type {CarrierConfig} */
export const geico = {
  id: 'geico',
  name: 'GEICO',
  hosts: [/(^|\.)geico\.com$/],
  // The buttons the fill presses are clicked from the page's own world (src/content/page-press.js),
  // inside an event the browser dispatches: GEICO's submit buttons send their own part of the request
  // only then, as with a mouse click. A script's click sent Recalculate without it, rated with
  // GEICO's own liability, UM, road service and cargo (W43-44).
  pressInPage: true,
  // What its pages draw that no other carrier does (gds-* components, the step bar, its spinners),
  // injected before the fill engine.
  pageAdapter: 'src/content/carriers/geico.js',
  // Fills on the quote and on the gateway, where the quote starts with the ZIP (TNI, 2026-10-21);
  // nothing else of the gateway. Page layouts as the agent works: the quote only.
  autoFillUrl: FILLED,
  layoutUrl: QUOTE,
  // The Start New Quote window opens over a gateway page already drawn: its first fill runs when
  // its questions show (the recorder's new_fields), as on arriving at a page. The gateway only.
  fillOnDraw: GATEWAY,
  // One address for every step: the step is read from the progress bar (pagekit stepKey) and named
  // in layouts, fill and field-change events only when it is one of these (src/usage.js knownStep).
  layoutSteps: STEPS,
  quoteSteps: STEPS.map((name) => ({ name, step: name })),
  // GEICO draws its questions with its own components: a fill waits for those the page hasn't
  // defined yet (pagekit `components`).
  components: 'gds-',
  // The generic label rules misfired on GEICO's pages (FL: the first driver in the owner's boxes,
  // the intake's phone in the mobile-homes cargo question).
  useGenericRules: false,
  // TNI's GEICO standards were set on a for-hire freight quote (FL, 2026-10-21): an expediter or a
  // freight hauler, as Progressive's. Any other class fills them in review mode (plan.js).
  supportedClasses: FOR_HIRE_CLASSES,
  // GEICO pre-selects answers everywhere (No on cargo, hired autos, non-owned and general
  // liability, Yes on the registered state, a value in every coverage list): ours replace them, as
  // on Progressive; anything the agent changed is left alone.
  replaceChoices: true,
  // Steps with one vehicle's (or trailer's) form, and one driver's: the agent's own edits there are
  // kept per unit (the panel's active vehicle or driver).
  vehicleSteps: [VEHICLES],
  driverSteps: [DRIVERS],
  // The intake driver GEICO lists itself (the owner who drives, added on Business & Owner Info): an
  // Add Driver form is never theirs, nor is Add Driver clicked for them (sidepanel pickUnitForm,
  // pickUnitToAdd). -1 for none.
  listedDriver,
  // The intake driver GEICO's quote leaves out (the owner's row, the first, when the intake says the
  // owner doesn't drive or marks that row Excluded: TNI, 2026-10-26 and 2026-10-27, answers to PR
  // questions T1, V3 and V4): never added, an Add Driver form never
  // theirs, and not a row of the driver list (sidepanel pickUnitForm, pickUnitToAdd). -1 for none.
  omittedDriver,
  // The lists of the units on the quote, by step (sidepanel pickUnitToAdd): which intake units each
  // shows (a VIN, a driver's name), how many it lists, and so the next unit to add.
  unitLists: [
    { steps: [VEHICLES], selector: VEHICLE_LIST, lists: ['vehicles', 'trailers'] },
    // An intake driver the list doesn't have, while the extension adds none (the panel's driver another
    // one): said in red with what to do (W44-01).
    { steps: [DRIVERS], selector: DRIVER_LIST, lists: ['drivers'], missing: driverMissing },
  ],
  // The units the fill adds itself, behind the panel's "Fill the pages" or "Click Continue when the
  // page is done" (TNI, FL live run 5, 2026-10-21, W43-20; FL live run 2026-10-21: "click + and add the new vehicle", "click Next after choosing Vehicle or
  // Trailer"): on the vehicle list the "+" for the next intake vehicle, then trailer, not on the
  // quote, the chooser answered for it (GiveVehicleOrTrailer) and its Next; on the driver list the
  // "+" for the next intake driver (never the owner GEICO lists). The unit's form is then filled
  // for it (pagekit unit forms). No step is left by these: saving the unit and Looks Good are the
  // `advance` below, and Discard is never clicked.
  actions: [
    addUnit('vehicles', VEHICLE_LIST, '+, Vehicle, Next'),
    chooseUnit('vehicles'),
    addUnit('trailers', VEHICLE_LIST, '+, Trailer, Next'),
    chooseUnit('trailers'),
    addUnit('drivers', DRIVER_LIST, 'the driver list\'s +'),
    // The owner the intake's only driver, who doesn't drive (omittedDriver): no driver is added, so
    // GEICO's quote would have none. TNI, 2026-10-27 (answer to PR question V1): a "needs you" item on
    // Drivers & Incidents, never clicked (no button), that holds Continue: the agent's.
    { id: 'noOtherDriver', steps: [DRIVERS], label: 'Drivers', when: noOtherDriver,
      missing: () => 'The intake has no driver besides the owner, who doesn\'t drive (the intake: "owner drives" No, or their driver row marked Excluded), so GEICO\'s quote leaves the owner out and the fill adds no driver. Which driver GEICO\'s quote lists is yours: add it, or answer "Is the owner a driver on the policy?" yourself on Business & Owner Info.' },

    // Quote & Coverages (TNI, FL live run 4, 2026-10-21). Motor Truck Cargo is a card under
    // "Optional 12 Mo. GEICO Commercial Policy Add-Ons", collapsed until its chevron is opened; its
    // questions show one at a time after each answer (W43-16). Opened when the intake asks for cargo,
    // clicked once: its chevron toggles, so a second click (a retry of a slow card) would close it.
    { id: 'openCargo', steps: [COVERAGES], token: 'editIcon', within: CARGO_CARD, label: 'Motor Truck Cargo',
      when: (r) => r.coverage?.cargo === true, unlessSelector: `${CARGO_CARD}.expanded` },
    // Trailer Interchange and Motor Truck General Liability, the same way, when the intake asks for
    // them (TNI, 2026-10-28: on an FL run the fill set the coverages, clicked Recalculate, View More
    // Payment Plans and Print Quote Proposal, and never opened either; the agent opened both by their
    // chevrons and answered them). Their questions are answered as they show, and Recalculate and
    // what follows it wait for them (sectionsOpened, sectionLimits). A card the page doesn't show
    // (GEICO not offering it) is said, and Recalculate is the agent's.
    { id: 'openInterchange', steps: [COVERAGES], token: 'editIcon', within: INTERCHANGE_CARD, label: 'Trailer Interchange',
      when: interchangeRequested, unlessSelector: INTERCHANGE_CARD.replace(/^li/, 'li.expanded'),
      missing: 'The intake asks for trailer interchange, and this page shows no Trailer Interchange card to open: add it or leave it yourself; Recalculate is yours.' },
    { id: 'openGl', steps: [COVERAGES], token: 'editIcon', within: GL_CARD, label: 'Motor Truck General Liability',
      when: glRequested, unlessSelector: `${GL_CARD}.expanded`,
      missing: 'The intake asks for general liability, and this page shows no Motor Truck General Liability card to open: add it or leave it yourself; Recalculate is yours.' },
    // Then, once nothing on the step is left for the agent (`whenClear`): Recalculate while the rates
    // are out of date, once a quote (TNI, 2026-10-21, W43-31). After each Recalculate the fill clicked
    // at once, GEICO drew the coverages again with its own choices wherever one wasn't saved yet
    // (liability and UM back to $750,000, road service declined, cargo $5k), the fill's and the
    // agent's alike; after each the agent clicked, it kept what the page showed (FL live run 6,
    // 2026-10-21). The fill's click was a script's: its request lacked the button's own part (171
    // entries, the agent's 172) and was rated 13 to 19 s later with GEICO's liability, UM, road
    // service and cargo, the agent's in about 2 s with every answer kept (2026-10-22, W43-44). It is
    // pressed from the page's own world now (`pressInPage`). It waits for a page quiet for 2 s
    // (`quietMs`), with none of GEICO's own requests finishing for 2 s either (its request every 2.0 s
    // left out: pagekit isBeat, 2026-10-23). It waits for the
    // premium up to a minute (GEICO's loader shows only 3 s in), and after GEICO's redraw every
    // answer is checked (`keepAnswers`): one of the fill's that GEICO changed is put back once, the
    // agent's is left, and each is a red item; it is never clicked again (`once`), so the agent
    // recalculates after that. With the premium current, each once (W43-18): View More Payment Plans
    // for TNI's 11 Payments (picked by its rule, or the plan with the most payments offered: W43-32),
    // and Print Quote Proposal once a plan is picked. Next stays the agent's: it leads to MVR & CLUE,
    // whose reports cost the agency.
    // Print Quote Proposal is clicked by the kit (`kitClick`), not pressed from the page's world: it
    // opens the proposal in a new tab, which a kit's click opened in 1 to 4 s on all 11 runs before
    // the page's-world press (2026-10-21 and 22), and that press on none of 4 (2026-10-23: one left 12
    // minutes, the agent's click opened it at once). Why is not known.
    // NTL picked for Liability Coverage: GEICO asks whether the customer is under permanent lease and
    // puts Liability Coverage back until it is answered (the maintainer, 2026-10-26, live run: Yes).
    // Clicked first thing the next round; due again whenever it shows again.
    { id: 'ntlLease', tni: 'general.ntl', steps: [COVERAGES], text: '^yes,?\\s*under permanent lease$', immediate: true, verify: 'gone', label: 'Yes, under permanent lease (NTL)', when: (r) => r.coverage?.ntl === true },
    // Rated only once GEICO draws the pay plans too (`ratedBy`): on 2026-10-26 (NTL, TX) the fill's
    // Recalculate left a total on the page with no coverage premiums and no pay plans, until the
    // agent's own Recalculate; the fill took it as rated and stopped without a word.
    { id: 'recalculate', steps: [COVERAGES], text: '^recalculate$', waitRequired: true, needsRecalculation: true, verify: 'premium', whenClear: true,
      quietMs: 2000, once: true, keepAnswers: true, ratedBy: '[id^="Id_GivePayPlanV2_"]', afterActions: sectionsOpened, after: sectionLimits },
    { id: 'morePayPlans', steps: [COVERAGES], text: '^view more payment plans$', needsPremium: true, whenClear: true, afterActions: sectionsOpened, after: sectionLimits },
    { id: 'printProposal', steps: [COVERAGES], text: '^print quote proposal$', needsPremium: true, whenClear: true, afterActions: sectionsOpened,
      after: (r) => ['geico.qGivePayPlanV2', ...sectionLimits(r)], kitClick: true },
  ],
  // Continue, with "Click Continue when the page is done" on, once nothing is left for the agent
  // (TNI, FL live run 3, 2026-10-21: "with Click Continue when its done on, GEICO's should click
  // Next"): Next on each step up to Additional Business Info and on a unit's form, Save and Continue
  // on Add Driver. Never on Quote & Coverages, whose Next leads to MVR & CLUE (paid reports), nor on
  // a stop step (`steps`), nor the chooser's Next (`notWithin`: the add helpers' own, after their
  // "+"; on a chooser the agent opened, Next is theirs). Looks Good leaves a unit list: only once the
  // panel has read the list and every intake unit is on it (`listed`, sidepanel pickUnitToAdd:
  // `unitsListed`). Continued per form and button (`byForm`): Vehicles is left by a Next on each
  // unit's form and then by Looks Good. GEICO draws some questions a moment after an answer (the
  // USDOT record's address check after the USDOT number; team driving and the hazmat placard after
  // "more about the business"): a fill that gave answers waits for a quiet page before it ends and
  // answers what was drawn, and a question drawn after that holds Continue (`quietMs`).
  advance: {
    text: '^(next|save and continue)$',
    listed: '^looks good$',
    steps: [BUSINESS_CLASS, BUSINESS_OWNER, VEHICLES, DRIVERS, MORE_BUSINESS],
    notWithin: CHOOSER_BUTTONS,
    byForm: true,
    quietMs: 800,
  },
  // Screens without a step of their own (the kit reads none there), by a button only they show:
  // nothing filled or clicked there, and the panel says so above the page's answers, in a quiet card
  // for a screen that is the agent's, in red as a stop page's for one that is GEICO's stop (`stopped`).
  // The first that matches names the screen.
  stopButtons: {
    // GEICO's "Add USDOT Number / Skip" (TNI, 2026-10-21, W43-27: SC and PA, after Business & Owner
    // Info on quotes without a USDOT number; the panel said nothing, and the agent asked for "a red
    // warning and blocker"). Add or Skip is the agent's. On an NTL quote TNI adds no USDOT number (TNI,
    // 2026-10-26, W44-28): said, and the screen is still the agent's (nothing clicked). With primary
    // auto liability too, or NTL not answered yet, the note says why the USDOT number is theirs (TNI,
    // 2026-10-26: answers to PR questions).
    'USDOT Number': {
      button: '^add usdot number$',
      note: (r) => (ntlNoDotFilings(r)
        ? 'GEICO asks for a USDOT number. This is a non-trucking liability (NTL) quote, and TNI adds no USDOT number on an NTL quote: Skip is yours.'
        : ntlDotFilingsHold(r) ? `GEICO asks for a USDOT number. ${ntlDotFilingsHold(r)} Add USDOT Number or Skip is yours.`
        : r?.applicant?.dot
        ? `GEICO asks for a USDOT number; the intake's is ${quote(r.applicant.dot)}. Add USDOT Number or Skip is yours.`
        : 'GEICO asks for a USDOT number, and the intake has none. Add USDOT Number or Skip is yours.'),
    },
    // GEICO's referral (TNI, 2026-10-26, W44-04: IL, after Additional Business Info): a page with no
    // questions, only Menu, GEICO's phone number and "Return to GEICO Gateway", and the panel said
    // nothing. GEICO won't quote the business online: GEICO's stop, in red.
    'GEICO referral': {
      button: '^return to geico gateway$',
      stopped: true,
      note: 'GEICO won\'t quote this business online: its page asks you to call GEICO at the number it shows. The quote is yours from here.',
    },
  },
  // Steps that are the agent's: nothing is filled or clicked there (not even on Fill this page), and
  // the AI assistant isn't asked.
  // The quote stops at Quote & Coverages (TNI, 2026-10-21): going on leads to MVR & CLUE, whose
  // reports cost the agency and are run only once the client shows interest in the offer.
  stopSteps: {
    'Final Quote Details': `Final Quote Details is yours: nothing is filled or clicked on this step. ${STOP_AT_QUOTE}`,
    'MVR & CLUE': `MVR & CLUE orders driving and claims reports, which cost the agency: that is yours. Nothing is filled or clicked on this step. ${STOP_AT_QUOTE}`,
    'Payment Information': 'Payment Information is yours: nothing is filled or clicked on this step.',
  },
  // The quote ends at Quote & Coverages with the proposal printed (TNI, 2026-10-21): the panel says
  // "Quote done" once Print Quote Proposal was clicked there and nothing is left for the agent.
  finishedBy: 'printProposal',
  // What the panel says on a step the fill still answers.
  stepNotes: {
    [COVERAGES]: 'The fill opens Motor Truck Cargo, Trailer Interchange and Motor Truck General Liability when the intake asks for them, and answers them. Answer what is left for you here (or mark it done) and click Fill this page, which also puts back any of its answers GEICO changed back. With nothing left, the fill clicks Recalculate once and checks every answer afterwards; if GEICO changed one, it is marked red and Recalculate is yours from then on. With the premium current, the fill picks 11 Payments (or the plan with the most payments GEICO offers) under View More Payment Plans and clicks Print Quote Proposal. Stop here: Next leads to MVR & CLUE, whose reports cost the agency; run them only once the client is interested.',
  },
  // GEICO requotes when a coverage changes, and puts back its own choices when the agent backs out
  // (FL live run, 2026-10-21: every follow-up fill set the liability limit again, and GEICO redrew the
  // quote each time, losing the agent's choices). On Quote & Coverages: no follow-up fill (only the
  // step's first fill and Fill this page), the pay plan and Print only once nothing is left for the
  // agent (`whenClear`, W43-18), and an answer the fill gave that the page shows otherwise since is
  // kept and flagged by an automatic fill (pagekit `takenBack`), and given again by the agent's Fill
  // this page (the maintainer, FL live run 6, 2026-10-21: GEICO's own choices put back over the
  // fill's, and the agent picked each one again by hand).
  // Its follow-up fills run only for questions it draws (FL live run 2, 2026-10-21: each cargo
  // question waited for the agent's Fill, and GEICO's own No to cargo stood until then), never after
  // an answer or a redraw.
  newQuestionsOnlySteps: [COVERAGES],
  // A Continue that hasn't moved the step is never clicked again (the panel's watchNextStep): GEICO
  // may still be working on it, with or without its spinner (FL live run 4, 2026-10-21, W43-13).
  continueRetry: false,
  keepTakenBack: [COVERAGES],
  // Each named by its data-model name where it has no record path (named).
  rules: named([
    // --- The gateway (gateway2.geico.com) --------------------------------------------------------
    // The quote starts with the ZIP in the Start New Quote window, over any gateway page (and the
    // USDOT check beside it on the dashboard); the gateway's own controls (search, coverage boxes,
    // alerts) are never answered. Never on the quote, whose own ZIP is GiveInitialZipCode.
    // A ZIP GEICO carried over from the last quote is replaced with the intake's (`replace`; TNI,
    // 2026-10-21, W43-28: 4 of 5 quotes opened with another ZIP, kept and flagged, and the agent
    // typed it); one the agent typed or marked done is theirs (the fill's skip), never replaced.
    { notPages: GATEWAY_OFF, selector: '#start-quote-zip', name: 'Start quote: ZIP (the garaging ZIP)', path: 'garaging.zip', source: 'derived', value: zip5, note: zipNote, replace: true },
    { notPages: GATEWAY_OFF, selector: '#dashboard-usdot', name: 'Start quote: USDOT number', path: 'applicant.dot', ignore: noDotOnQuote, note: holdOr(dotNumberNote) },
    // The Search Products window (TNI, FL live run 3, 2026-10-21: "after Search Products you should
    // select commercial auto"): Commercial Auto/Trucking ticked, and no other product; its own USDOT
    // box takes the intake's number.
    { notPages: GATEWAY_OFF, selector: `${PRODUCT}#commercial, ${PRODUCT}[value="commercial"]`, name: 'Start quote: Commercial Auto/Trucking (TNI: ticked)', q: 'gatewayCommercial', tni: 'geico.product',
      kind: 'bool', source: 'standard', value: () => true },
    { notPages: GATEWAY_OFF, selector: '#start-quote-usdot', name: 'Start quote: USDOT number (Search Products)', path: 'applicant.dot', ignore: noDotOnQuote, note: holdOr(dotNumberNote) },
    // The gateway's own controls are never answered: the header search, the other products, the
    // alerts settings. One rule each, as a selector rule answers its first match only (the header
    // search took the one that named the products too, and they were left unfamiliar). The product
    // boxes Commercial Auto's rule didn't take, however many the window draws (`every`; FL live run
    // 5, 2026-10-21, W43-25: one more than the saved window's four was listed as unfamiliar).
    ...[['input[name="header-search-type"]', 'Gateway: policy or quote search'], ['#search-input-id', 'Gateway: search box'],
      [PRODUCT, 'Gateway: another product (never ticked)', true],
      ['[id^="alerts-pref"]', 'Gateway: alerts settings']]
      .map(/** @param {any[]} row @returns {CarrierRule} */ ([selector, name, every = false]) => ({ notPages: GATEWAY_OFF, selector, name, q: 'gatewayDashboard', ignore: true, every })),
    // --- Business Class & USDOT ----------------------------------------------------------------
    ...on(BUSINESS_CLASS, {}, [
      { field: 'GiveInitialZipCode', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: 'ZIP code (the garaging ZIP)', source: 'derived', value: zip5, note: zipNote },
      { tni: 'geico.current-geico-policy', field: 'GiveCurrentGeicoCommercialAutoPolicyYesNo', ask: 'Does the customer\'s business have a current GEICO commercial auto policy?', name: 'Current GEICO commercial auto policy',
        kind: 'bool', source: currentGeicoSource, clientFact: true, value: currentGeico, note: currentGeicoNote },
      { field: 'GiveDepartmentOfTransportationNumber', ask: 'What is the customer\'s USDOT number?', path: 'applicant.dot', ignore: noDotOnQuote, note: holdOr(dotNumberNote) },
      // The business description lists 1,599 kinds of business (too many for the AI assistant), the
      // more detailed one 26. An expediter or a general freight hauler is For Hire Trucking, then
      // Other For-Hire Trucking (TNI, 2026-10-21: forHire). Any other class is the agent's pick,
      // never matched by words ("Freight Hauler" isn't "Freight Forwarder").
      { field: 'GivePrimaryBusinessDescription', ask: 'Please choose what best describes the customer\'s business.', tni: 'geico.business-description', name: 'Business description (For Hire Trucking for an expediter or freight hauler)',
        kind: 'choice', source: describeSource, value: (r) => (forHire(r) ? 'For Hire Trucking' : null), note: (r) => (forHire(r) ? null : describeNote('What best describes the business')(r)) },
      { field: 'GiveSecondaryBusinessDescription', ask: 'Please give us a little more information about what the customer\'s business does.', tni: 'geico.business-description', name: 'More about the business (Other For-Hire Trucking for an expediter or freight hauler)',
        kind: 'choice', source: describeSource, value: (r) => (forHire(r) ? 'Other For-Hire Trucking' : null), note: (r) => (forHire(r) ? null : describeNote('The more detailed description')(r)) },
      // GEICO is the first carrier mapped to ask it. Intakes from before the question are null:
      // unanswered, which is TNI's No unless the notes mention a team (W43-34).
      { field: 'TeamDrivingOrSlipSeatingYesNo', ask: 'Do any of your customer\'s vehicles require team driving or slip seating to keep the vehicle continuously moving?', path: 'operations.teamDriving', tni: 'geico.team-driving', name: 'Team driving or slip seating (TNI: No unless the intake says otherwise)',
        kind: 'bool', ...noUnless((r) => r.operations.teamDriving, teamMention), note: teamNote },
      // The intake's answer; blank is TNI's No unless the intake points to hazardous freight (W43-34).
      { field: 'GiveAnyVehicleNeedHazardousMaterialPlacardYesNo', ask: 'Do any of the customer\'s vehicles or loads require a hazardous material placard?', path: 'operations.hazPlacard', tni: 'general.hazmat-placard', name: 'Hazardous material placard (TNI: No unless the intake says otherwise)',
        kind: 'bool', ...noUnless((r) => r.operations.hazPlacard, placardMention), note: placardNote },
      // The intake's ELD answer (GA live run, 2026-10-21, W43-29: only the AI assistant answered it).
      { field: 'GiveElectronicLoggingDevice', ask: 'Does the customer have an electronic logging device (ELD) in their vehicle(s)?', path: 'operations.usesEld', name: 'Electronic logging device (ELD)', kind: 'bool',
        note: (r) => (typeof r.operations.usesEld === 'boolean' ? null : 'The intake doesn\'t say whether the vehicles have an ELD: answer it yourself.') },
      // Not shown on the captured quotes (what reveals it isn't known).
      { field: 'GiveFilingType', name: 'State or federal filing', kind: 'choice', source: held((r) => (ntlNoFilings(r) ? 'standard' : 'derived')), clientFact: true, value: filingType, note: holdOr(filingTypeNote) },
      // Questions shown for other kinds of business (hidden on the captured quotes): not on the
      // intake, a general freight class doesn't make them No.
      fact('GiveAnyVehicleTransportFoodYesNo', 'Food delivery (UberEats, DoorDash)'),
      fact('GiveDeliverPackagesForAmazonYesNo', 'Amazon package delivery'),
      fact('GiveApplicationsToProcessAmazonDeliveries', 'Amazon delivery programs'),
      fact('GiveIsAmazonDeliveryServicePartnerOwnerYesNo', 'Amazon Delivery Service Partner owner'),
      fact('GiveAnyVehicleHaulOilAndGasFieldsYesNo', 'Hauls to or from oil and gas fields'),
      fact('GiveAnyVehicleHaulCoiledSteelYesNo', 'Hauls coiled steel'),
      fact('AnyVehicleTransportClientsYesNo', 'Transports clients for a fee'),
      fact('AnyVehicleTransportChilderForDayCareYesNo', 'Transports children for a daycare'),
      fact('TransportSeasonalTemporaryWorkersYesNo', 'Transports seasonal or temporary workers'),
    ]),
    // Shown with a USDOT number (and hidden on Additional Business Info).
    ...on([BUSINESS_CLASS, MORE_BUSINESS], {}, [
      { field: 'GiveDepartmentOfTransportationNumberStatus', ask: 'Does the customer have a USDOT Number registered to themselves or their business?', name: 'Has a USDOT number',
        kind: 'choice', source: held(dotStatusSource), clientFact: true, value: dotStatus, note: holdOr(dotStatusNote) },
      // "USDOT Information: Is this the customer's business?", under GEICO's record of the number:
      // Yes when the record (the question's text) shows the intake's house number, street and ZIP;
      // otherwise the agent checks it against the client (TNI, FL live run 5, 2026-10-21, W43-24).
      { field: 'GiveExtendUsDotVerifyBusinessAddress', name: 'USDOT record is the client\'s business (Yes when it shows the intake\'s street and ZIP)', kind: 'bool',
        source: (r) => (recordWords(r) ? 'derived' : 'attestation'), value: (r) => (recordWords(r) ? true : null), labelHas: recordWords,
        labelNote: RECORD_NOTE, note: (r) => (recordWords(r) ? null : RECORD_NOTE) },
    ]),

    // --- Business & Owner Info -----------------------------------------------------------------
    ...on(BUSINESS_OWNER, {}, [
      ...OWNER_IDENTITY,
      // Prefilled by GEICO; never the application date or the prior policy's expiration.
      { field: 'GiveEffectiveDate', name: 'Coverage start date (as GEICO has it)', ignore: true,
        emptyNote: 'GEICO left the coverage start date empty, and it isn\'t on the intake: pick it yourself.' },
      { field: 'GiveMaritalStatus', ask: 'Marital Status', name: 'Owner marital status', kind: 'choice', source: 'derived', clientFact: true,
        value: (r) => ownerDetails(r)?.maritalStatus ?? null, note: ownerRowNote('marital status') },
      { field: 'GivePhoneNumber', ask: 'Please confirm the owner\'s phone number', path: 'applicant.phone', name: 'Owner phone (the intake\'s phone)', note: phoneNote },
      { field: 'GiveBusinessPhoneNumber', ask: 'Please confirm the business phone number', path: 'applicant.phone', name: 'Business phone', note: phoneNote },
      { field: 'GiveEmail', ask: 'What\'s the customer\'s email address?', path: 'applicant.email', name: 'Customer email' },
      { field: 'GiveBusinessOwnershipType', ask: 'Business ownership type:', name: 'Business ownership type (from the company name)', kind: 'choice', source: 'derived', clientFact: true, value: ownershipType, note: ownershipNote, warn: ownershipWarn },
      // The intake's answer; a blank box is TNI's standard Yes, and an owner whose driver row the
      // intake marks excluded is not a driver, No (TNI, 2026-10-26, W44-25: util.js ownerDrives).
      // The owner's row is the first (TNI, 2026-10-27: answer to PR question V4), so a later row with
      // the owner's name, marked or not, changes nothing: V4 replaces the 2026-10-26 answer that left
      // the owner's name on several rows, only some excluded, to the agent.
      { tni: 'general.owner-drives', field: 'GiveOwnerActiveDriverStatusYesNo', ask: 'Is the owner a driver on the policy?', path: 'applicant.ownerDrives', name: 'Owner is a driver (TNI: Yes when the intake leaves it blank, unless excluded)', kind: 'bool',
        source: ownerDrivesSource, value: ownerDrives, warn: ownerDrivesWarn },
      // Yes when the owner drives and isn't excluded; No otherwise (TNI, 2026-10-27).
      { tni: 'general.owner-daily-ops', field: 'GiveOwnerInvolvedInDailyOperationsYesNo',
        ask: 'Is the owner involved in the daily operations of the business?',
        name: 'Owner involved in daily operations (Yes when the owner drives)', kind: 'bool',
        source: ownerDailyOpsSource, value: ownerDailyOps, warn: ownerDrivesWarn },
    ]),
    // Never filled, wherever GEICO asks it (and never logged: typed values never are).
    fact('GiveSocialSecurityNumber', 'Owner Social Security number (never filled)', { steps: [BUSINESS_OWNER, VEHICLES], ask: 'Business Owner Social Security Number',
      note: 'The owner\'s Social Security number is never filled: enter it yourself only if the client gave it.' }),

    // --- Vehicles ------------------------------------------------------------------------------
    // The owner's identity again, with the Social Security number.
    ...on(VEHICLES, { whenShown: OWNER_CHECK }, OWNER_IDENTITY),
    ...on(VEHICLES, {}, [
      // The chooser behind Add Vehicle or Trailer: the unit the panel is adding (the intake's next
      // vehicle, then trailer, not on the quote: pickUnitToAdd), also when the agent clicked "+".
      // With none left, or the list not read yet, it is the agent's (a fact: never the AI assistant's).
      { field: 'GiveVehicleOrTrailer', ask: 'What would the customer like to add?', name: 'Vehicle or trailer to add (the next intake unit not on the quote)', kind: 'choice',
        source: (r, a) => (chosen(r, a) ? 'derived' : 'fact'), value: chosen,
        note: (r, a) => (chosen(r, a) ? null : 'Every intake vehicle and trailer looks to be on the quote already: pick Vehicle or Trailer for the unit you are adding yourself.') },
      // GEICO works it out from the values (disabled), on both forms.
      { field: 'GiveStatedAmount', name: 'Stated amount (GEICO works it out)', ignore: true },
    ]),
    ...on(VEHICLES, { whenShown: VEHICLE_FORM }, [
      { field: 'YesNoPreQuoteHaveFullVinActivity', ask: 'Entering the customer\'s VIN can help speed things up. Do you have it handy?', path: 'vehicles[].vin', name: 'VIN at hand',
        kind: 'bool', source: 'derived', value: (r, a) => (hasVin(r, a) ? true : null), note: (r, a) => (hasVin(r, a) ? null : 'The intake has no VIN for this vehicle: answer it yourself.') },
      { field: 'GiveVinPreQuote', path: 'vehicles[].vin', name: 'VIN' },
      { field: 'GiveYear', ask: 'Year', path: 'vehicles[].year', name: 'Vehicle year', kind: 'choice', verifyOnly: hasVin },
      { field: 'GiveMake', path: 'vehicles[].make', name: 'Vehicle make', kind: 'choice', verifyOnly: hasVin },
      { field: 'GiveModel', path: 'vehicles[].model', name: 'Vehicle model', kind: 'choice', verifyOnly: hasVin },
      // 40 kinds of vehicle: "Van" alone is five of them.
      { field: 'GiveOtherVehicleType', waitFor: afterDecode, ask: 'Which of the following best describes the customer\'s vehicle?', tni: 'geico.vehicle-type', name: 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, Box Truck or else Box/Straight Truck for a box truck, else the agent\'s pick)', kind: 'choice',
        source: (r, a) => (vehicleType(r, a) ? 'standard' : null), value: vehicleType, choiceAliases: vehicleTypeAliases, note: (r, a) => (vehicleType(r, a) ? null : typeNote('vehicle', vehicleOf)(r, a)) },
      { field: 'GiveAnyVehicleCustomizationYesNo', waitFor: afterDecode, ask: 'Does the customer have any customizations?', path: 'operations.equipVehicle', tni: 'geico.customizations', name: 'Customizations (from the attached equipment value)',
        kind: 'bool', source: valueSource(noEquipValue), clientFact: true, value: customization, note: customizationNote },
      { field: 'GiveTotalCustomizationValue', waitFor: afterDecode, ask: 'What is the total value of the customizations or modifications to the vehicle?', path: 'operations.equipVehicle', tni: 'geico.customizations', name: 'Customization value (the attached equipment value, else TNI: 0)',
        kind: 'money', source: valueSource(noEquipValue), value: customizationValue, note: customizationValueNote },
      // Its value without the customizations: the intake's vehicle value (today's, never cost new).
      { field: 'GiveCostExcludingPermanentlyAttachedEquipment', waitFor: afterDecode, path: 'vehicles[].value', name: 'Vehicle value without customizations', kind: 'money', note: valueNote('vehicle', vehicleOf) },
      fact('GiveDetailedCostNew', 'Cost new', { note: 'What the vehicle cost new isn\'t on the intake (its value there is today\'s): answer it yourself.' }),
      // Also sets GEICO's lowest liability limit: never worked out from the type or model. TNI
      // (2026-10-21): GEICO's own band, from the VIN, is kept.
      { field: 'GiveGrossVehicleWeight', ask: 'What is the Gross Vehicle Weight (GVW)?', name: 'Gross vehicle weight (as GEICO has it)', ignore: true,
        emptyNote: 'GEICO left the gross vehicle weight empty, and it isn\'t on the intake: answer it from the registration.' },
      { field: 'GiveCommercialVehicleCompCollision', waitFor: afterDecode, ask: 'Would the customer like to add comprehensive or collision coverage?', tni: 'geico.comp-coll', name: 'Comprehensive or collision wanted (TNI: Yes)',
        kind: 'bool', source: physicalDamageSource, value: () => true, note: physicalDamageNote('whether to add comprehensive or collision') },
      ...parking('vehicle'),
      { field: 'GiveFarthestOneWayDistance', waitFor: afterDecode, ask: 'What is the farthest one-way distance (in miles) this vehicle travels for work?', name: 'Farthest one-way distance (from the radius)',
        kind: 'choice', source: 'derived', value: distanceBand, note: distanceNote },
      { field: 'GiveCommercialVehicleForPersonalUse', waitFor: afterDecode, ask: 'Is this vehicle ever used for personal use?', path: 'operations.personalUse', name: 'Personal use',
        kind: 'bool', source: 'derived', value: personalUse, note: personalUseNote },
      fact('GiveRegisteredStateYesNo', 'Registered in the garaging state'),
      // Shown for other uses (hidden on the captured quotes): a commercial quote doesn't make them Yes.
      fact('GiveVehicleUsedForPackageDelivery', 'Used for package delivery'),
      fact('GiveVehicleIsUsedForFoodDelivery', 'Used for food delivery'),
      fact('GiveVehicleUsedForBusinessOperations', 'Used for business operations'),
      fact('GiveVehicleUsedForPrimarySourceOfIncome', 'Primary source of income'),
      fact('GiveVehicleTowingOrRepossessionYesNo', 'Towing or repossession'),
    ]),
    // The trailer form (NE): the active trailer's answers, never a vehicle's.
    ...on(VEHICLES, { whenShown: TRAILER_FORM }, [
      { field: 'GiveYear', ask: 'Year', path: 'trailers[].year', name: 'Trailer year', kind: 'choice' },
      // 19 kinds of trailer: a gooseneck hitch isn't a Gooseneck Trailer.
      { field: 'GiveOtherVehicleType', q: 'GiveOtherVehicleType.trailer', ask: 'Which of the following best describes the customer\'s trailer?', name: 'Trailer type (the agent\'s pick)', note: typeNote('trailer', trailerOf) },
      { field: 'GiveCommercialVehicleCompCollision', q: 'GiveCommercialVehicleCompCollision.trailer', ask: 'Would the customer like to add comprehensive or collision coverage?', tni: 'geico.comp-coll', name: 'Trailer comprehensive or collision wanted (TNI: Yes)',
        kind: 'bool', source: physicalDamageSource, value: () => true, note: physicalDamageNote('whether to add comprehensive or collision on this trailer') },
      { field: 'GiveTotalCustomizationValue', q: 'GiveTotalCustomizationValue.trailer', path: 'trailerInfo.equipTrailer', tni: 'geico.customizations', name: 'Trailer customization value (the trailer equipment value, else TNI: 0)',
        kind: 'money', source: valueSource(noTrailerValue), value: trailerCustomizationValue, note: trailerCustomizationNote },
      { field: 'GiveCostExcludingPermanentlyAttachedEquipment', path: 'trailers[].value', name: 'Trailer value without customizations', kind: 'money', note: valueNote('trailer', trailerOf) },
      ...parking('trailer'),
      { field: 'GiveFarthestOneWayDistance', q: 'GiveFarthestOneWayDistance.trailer', name: 'Trailer farthest one-way distance (from the radius)', kind: 'choice', source: 'derived', value: distanceBand, note: distanceNote },
      fact('GiveRegisteredStateYesNo', 'Trailer registered in the garaging state', { q: 'GiveRegisteredStateYesNo.trailer' }),
    ]),

    // --- Drivers & Incidents -------------------------------------------------------------------
    // The driver GEICO adds for an owner who drives (named after the owner): the owner's answers,
    // from their driver row, never the panel's active driver.
    ...on(DRIVERS, { unlessShown: OWNER_DRIVER_FORM }, [
      { field: 'GiveDriverLicenseState', q: 'GiveDriverLicenseState.owner', name: 'Owner\'s license state', kind: 'state', source: 'derived', value: (r) => ownerDetails(r)?.licenseState ?? null, note: ownerRowNote('license state') },
      { field: 'GiveCertificateOfFinancialResponsibilityDriverYesNo', ask: 'We just need a little more info about this driver. Do they need a Certificate of Financial Responsibility or SR-22?',
        path: 'operations.needSr22', tni: 'geico.sr22', name: 'SR-22 (the owner; TNI: No unless the intake says otherwise)', kind: 'bool', source: sr22Source, value: sr22Owner, note: sr22Note(sr22Owner) },
      // A blank CDL box on the intake is No (the maintainer, 2026-10-26: TNI's standard; cdlAnswer).
      { field: 'CommercialDriverLicense', q: 'CommercialDriverLicense.owner', ask: 'Does this driver have a CDL?', tni: 'general.cdl-blank', name: 'Owner has a CDL (TNI: No when the intake leaves it blank)', kind: 'bool',
        source: (r) => (cdlStandard(ownerDetails(r)) ? 'standard' : 'derived'), value: (r) => cdlAnswer(ownerDetails(r)), note: ownerRowNote('CDL answer') },
    ]),
    // Add Driver: the panel's active driver.
    ...on(DRIVERS, { whenShown: ADD_DRIVER_FORM }, [
      { field: 'GiveFirstName', ask: 'First Name', path: 'drivers[].first', name: 'Driver first name', note: driverNote((r, a) => (driverOf(r, a)?.first?.length > MAX_NAME ? nameNote(driverOf(r, a).first, 'driver\'s first name') : null)), warn: excludedWarn },
      { field: 'GiveLastName', ask: 'Last Name', path: 'drivers[].last', name: 'Driver last name', note: driverNote((r, a) => (driverOf(r, a)?.last?.length > MAX_NAME ? nameNote(driverOf(r, a).last, 'driver\'s last name') : null)) },
      // GEICO is the first carrier mapped with a suffix box.
      { field: 'GiveDriverSuffix', ask: 'Suffix', path: 'drivers[].suffix', name: 'Driver suffix', kind: 'choice', optional: true, note: driverNote() },
      { field: 'GiveDateOfBirth', ask: 'Date of Birth', path: 'drivers[].dob', name: 'Driver date of birth', kind: 'date', note: driverNote(dobNote) },
      { field: 'GiveDriverLicenseState', ask: 'Driver\'s License State', path: 'drivers[].licenseState', name: 'Driver license state', kind: 'state', note: driverNote() },
      { field: 'GiveDriverRelationshipToBusiness', ask: 'What is their relationship to the business?', tni: 'geico.relationship', name: 'Driver\'s relationship to the business (Owner, else Employee)', kind: 'choice', source: relationshipSource, clientFact: true,
        value: relationship, note: driverNote(relationshipNote) },
      { field: 'CommercialDriverLicense', ask: 'Does this driver have a CDL?', path: 'drivers[].cdl', tni: 'general.cdl-blank', name: 'Driver has a CDL (TNI: No when the intake leaves it blank)', kind: 'bool',
        source: (r, a) => (cdlStandard(driverOf(r, a)) ? 'standard' : 'intake'), value: (r, a) => cdlAnswer(driverOf(r, a)), note: driverNote() },
      // Hidden on the captured Add Driver form.
      { field: 'GiveCertificateOfFinancialResponsibilityDriverYesNo', path: 'operations.needSr22', tni: 'geico.sr22', name: 'SR-22 (this driver; TNI: No unless the intake says otherwise)', kind: 'bool', source: sr22Source, value: sr22Driver, note: driverNote(sr22Note(sr22Driver)) },
      // Asked again on Add Driver for a driver who is the business's owner, with the owner's mobile
      // phone (PA live run, 2026-10-21, W43-29: both unfamiliar, the first answered by the AI
      // assistant from the intake): the owner-drives answer of Business & Owner Info (a blank box
      // TNI's Yes, W44-25) and the intake's phone. Open (W43-26): on that run GEICO redrew this
      // question as Yes after Save and Continue; the answer here is the same one the agent approved
      // there.
      { tni: 'general.owner-drives', field: 'GiveOwnerActiveDriverStatusYesNo', q: 'GiveOwnerActiveDriverStatusYesNo.driver', ask: 'Is the owner a driver on the policy?', path: 'applicant.ownerDrives', name: 'Owner is a driver (Add Driver; TNI: Yes when the intake leaves it blank, unless excluded)', kind: 'bool',
        source: ownerDrivesSource, value: ownerDrives, warn: ownerDrivesWarn, note: driverNote() },
      { field: 'GiveMobilePhoneNumber', ask: 'Owner\'s Mobile Phone Number', path: 'applicant.phone', name: 'Owner\'s mobile phone (the intake\'s phone)', note: driverNote(phoneNote) },
    ]),

    // --- Additional Business Info --------------------------------------------------------------
    ...on(MORE_BUSINESS, {}, [
      { field: 'GiveBusinessStartDate', ask: 'How many years has this business been operating?', path: 'applicant.yearsInBusiness', name: 'Years in business', kind: 'choice', source: 'derived',
        value: (r) => startBucket(r.applicant.yearsInBusiness), note: (r) => (startBucket(r.applicant.yearsInBusiness) != null ? null
          // A range in the notes whose ends differ (TNI, 2026-10-27: answer to PR question V7).
          : r.applicant.yearsInBusinessRange === true ? 'The notes give years in business as a range: answer it yourself.'
            : 'The intake has no years in business (or year established): answer it yourself.') },
      { field: 'GiveNumberOfEmployees', ask: 'How many employees does the customer\'s business have, including part-time employees?', tni: 'geico.employees', name: 'Number of employees (the drivers besides the owner)', kind: 'choice',
        source: (r) => (employees(r) ? 'standard' : 'fact'), value: employees, note: (r) => (employees(r) ? null : 'The intake lists no drivers: answer how many employees the business has yourself.') },
      { tni: 'geico.current-auto', field: 'GiveCurrentAutoInsuranceStatus', ask: 'Does the customer currently have personal or commercial auto insurance?', name: 'Currently has auto insurance', kind: 'choice', source: currentAutoSource, clientFact: true, value: currentAuto, note: currentAutoNote },
      fact('GiveInsurancePriorToBeingDeployed', 'Insured before being deployed'),
      { field: 'GiveYearsWithCurrentAutoInsurer', ask: 'How long has the customer been with their current auto insurance company?', tni: 'geico.years-with-insurer', name: 'Years with the current auto insurer (1-3 with a current policy)', kind: 'choice',
        source: yearsSource, value: yearsWithInsurer, note: yearsNote },
      { field: 'GiveCurrentBodilyInjuryLimits', ask: 'What bodily injury limits does the customer currently have on their vehicle insurance?', path: 'priorInsurance[0].limit', name: 'Current bodily injury limits',
        kind: 'choice', source: 'derived', value: currentBi, note: currentBiNote },
      { field: 'GiveOtherLiabilityInsurance', ask: 'What kind of liability insurance does the customer currently have to cover their business?', tni: 'geico.other-liability', name: 'Liability insurance the business has (None unless the notes say)',
        kind: 'choice', source: otherLiabilitySource, clientFact: true, value: otherLiability, note: otherLiabilityNote },
      // TNI (2026-10-21): No for every intake.
      // TNI, 2026-10-27: No at quote; any needed AI/waiver is added after the policy starts. GEICO
      // reworded the named-AI question (dropped "or a designated insured"); both wordings match.
      { field: 'GiveInsuredOrWaiverYesNo', tni: 'general.additional-insured',
        ask: ['Does the customer need to add a named additional insured? Or do they need a named waiver of subrogation?',
          'Does the customer need to add a named additional insured or a designated insured? Or do they need a named waiver of subrogation?'],
        name: 'Named additional insured or waiver of subrogation (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasContractForBlanketAiEndorsement', ask: 'Does the customer have a contract that requires a blanket additional insured endorsement?', tni: 'general.additional-insured', name: 'Blanket additional insured by contract (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasContractForBlanketWosEndorsement', tni: 'general.additional-insured', name: 'Blanket waiver of subrogation by contract (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasFilingsYesNo', ask: 'Is the customer required to provide proof of insurance/filings to a state or federal agency?', path: 'operations.filingsRequired', tni: 'geico.filings', name: 'Filings required (TNI: No unless the intake says otherwise)',
        kind: 'bool', value: (r) => (ntlNoDotFilings(r) ? false : hasFilings.value(r)), source: held((r) => (ntlNoFilings(r) ? 'standard' : hasFilings.source(r))), note: holdOr(filingsNote) },
      // Shown after Yes (FL): only a box the intake names is ticked.
      { field: 'AddFilings.FederalLiability', ask: 'Federal Liability (includes MCS-90)', path: 'operations.filingsWhich', name: 'Federal liability filing', kind: 'bool', source: held('derived'),
        value: (r) => filingBoxes(r).federal, ignore: (r) => !filingBoxes(r).federal, note: holdOr() },
      { field: 'AddFilings.MCS90', ask: 'MCS-90', name: 'MCS-90 filing (as the page has it)', ignore: true },
      { field: 'AddFilings.StateFiling', ask: 'State', path: 'operations.filingsWhich', name: 'State filing', kind: 'bool', source: held('derived'),
        value: (r) => filingBoxes(r).state, ignore: (r) => !filingBoxes(r).state, note: holdOr() },
    ]),

    // --- Quote & Coverages ---------------------------------------------------------------------
    ...on(COVERAGES, {}, [
      fact('PolicyTermSliderCollect', 'Policy term'),
      // TNI's 11 Payments (FL live run 4, 2026-10-21, W43-18), one of the plans View More Payment
      // Plans shows (`whenOffered`: waited for until then). Two groups (pay in full and
      // installments, each with its own name): one rule each; the one listing it is answered. Not
      // offered once View More Payment Plans was clicked (TX: Pay In Full, 4 Payments Bi-Monthly
      // Plan, 9 Payments): the plan with the most payments offered, Pay In Full counting one, named
      // in the report (TNI, 2026-10-21, W43-32).
      ...[1, 2].map(/** @returns {CarrierRule} */ () => ({ field: 'GivePayPlanV2', tni: 'geico.pay-plan', name: 'Payment plan (TNI: 11 Payments)', kind: 'choice', source: 'standard', value: () => PAY_PLAN,
        each: true, whenOffered: true, orMost: { count: '^(\\d+)\\s+payments?\\b', one: '^pay\\s+in\\s+full\\b', after: 'morePayPlans', name: 'the plan with the most payments GEICO offers' } })),
      { q: 'LiabilityCoverage', ask: 'Liability Coverage', control: 'select', name: 'Liability coverage', kind: 'choice', source: 'derived', value: liabilityType, note: liabilityNote },
      // The intake's limit, by its amount ($1M CSL is "$1,000,000 Combined Single Limit"). A split
      // limit, State Minimum or one GEICO doesn't offer finds no option: the agent's, never the next one up.
      { ask: 'Bodily Injury or Combined Single Limit Liability', control: 'select', path: 'coverage.autoLiabLimit', name: 'Liability limit', kind: 'choice', ignore: ntlQuote,
        note: (r) => ntlNote(r) ?? (liabilityType(r) ? null : 'Pick the liability limit yourself, with the liability coverage.') },
      // An NTL quote: the intake's liability limit in GEICO's NTL list (the same choices, $300,000 to
      // $1,000,000 CSL), drawn once the permanent lease is answered.
      { ask: 'Non Trucking Liability (NTL)', control: 'select', path: 'coverage.autoLiabLimit', name: 'Non-trucking liability limit (the intake\'s liability limit)', kind: 'choice',
        ignore: (r) => !ntlQuote(r) },
      // TNI's $100,000 CSL, in every state (FL live run 4, 2026-10-21, W43-17: GEICO pre-selected
      // $750,000); Texas lists only split limits, $100,000/$300,000 there (W43-33), but CSL ones with
      // a CSL liability or NTL (2026-10-26 live run: no split option, UM left at GEICO's $300,000):
      // $100,000 CSL then. A state without either option leaves it to the agent. After NTL is
      // accepted GEICO resets it; GEICO fills one answer a round in page order, so UM comes after. GA and SC caption it "(UMBI)", SC asks underinsured
      // separately: the same limit (W43-33, TNI, 2026-10-21).
      { q: 'UninsuredMotorist', ask: 'Uninsured Motorist Bodily Injury (includes Underinsured)', control: 'select', tni: 'geico.um', name: `Uninsured motorist bodily injury (TNI: ${usd(STANDARDS.umCsl)} CSL; TX ${UM_SPLIT})`,
        kind: 'choice', source: 'standard', value: (r) => (texas(r) ? UM_SPLIT : UM_LIMIT), choiceAliases: (r) => (texas(r) ? [UM_LIMIT] : []) },
      { q: 'UninsuredMotoristUmbi', ask: 'Uninsured Motorist Bodily Injury (UMBI)', control: 'select', tni: 'geico.um', name: `Uninsured motorist bodily injury, UMBI (TNI: ${usd(STANDARDS.umCsl)} CSL)`,
        kind: 'choice', source: 'standard', value: () => UM_LIMIT },
      { q: 'UnderinsuredMotorist', ask: 'Underinsured Motorist Bodily Injury (UIMBI)', control: 'select', tni: 'geico.um', name: `Underinsured motorist bodily injury, UIMBI (TNI: ${usd(STANDARDS.umCsl)} CSL)`,
        kind: 'choice', source: 'standard', value: () => UM_LIMIT },
      // TNI, 2026-10-27: when a state asks UM/UIM type or deductible (another form of the UM
      // questions), type is Add-On and deductible $1,000; the deductible isn't always shown.
      { q: 'UninsuredMotoristDeductible', ask: 'Uninsured Motorist Deductible', control: 'select', tni: 'geico.um',
        name: 'Uninsured motorist deductible (TNI: $1,000)', kind: 'choice', source: 'standard', value: () => '$1,000' },
      { q: 'UmUimType', ask: 'UM/UIM Type', control: 'select', tni: 'geico.um',
        name: 'UM/UIM type (TNI: Add-On)', kind: 'choice', source: 'standard', value: () => 'Add-On' },
      // Property damage liability and UMPD stay the agent's (W43-33).
      { q: 'PropertyDamage', ask: 'Property Damage Liability (PD)', control: 'select', name: 'Property damage liability', source: 'fact' },
      { q: 'UninsuredMotoristPd', ask: 'Uninsured Motorist Property Damage (UMPD)', control: 'select', name: 'Uninsured motorist property damage', source: 'fact' },
      // FL: one choice each, kept as GEICO has them (pipKept).
      { q: 'Stacked', ask: 'Is Stacked', control: 'select', name: 'Stacked uninsured motorist', ...pipKept('stacked uninsured motorist') },
      // Medical Payments $5,000, Not Included where GEICO lists no limit; Basic PIP declined beside
      // medical payments, $2,500 without (TNI, 2026-10-26, W44-26; above). The page kit reads the lists.
      { q: 'MedicalPayments', ask: 'Medical Payments (MED)', control: 'select', tni: 'geico.medpay-pip', name: `Medical payments (TNI: ${MED_PAY}; Not Included where GEICO offers no limit)`, kind: 'choice',
        source: 'standard', value: () => MED_PAY, onlyIf: [{ limit: true }, { limit: false, value: 'Not Included' }],
        unofferedNote: 'GEICO doesn\'t list $5,000 medical payments here: pick it yourself (TNI takes $5,000 medical payments wherever GEICO offers them).' },
      { q: 'BasicPip', ask: 'Basic Personal Injury Protection', control: 'select', tni: 'geico.medpay-pip', name: 'Basic personal injury protection (TNI: declined beside medical payments, else $2,500; FL: as GEICO has it)', kind: 'choice',
        ignore: florida, source: (r) => (florida(r) ? null : 'standard'), value: (r) => (florida(r) ? null : '$2,500'),
        onlyIf: (r) => (florida(r) ? null : [{ path: MED_PATH, limit: true, value: 'I decline' }, { path: MED_PATH, limit: false }]),
        unofferedNote: 'GEICO doesn\'t offer the basic personal injury protection answer TNI takes here (I decline beside medical payments, else $2,500): pick it yourself.',
        emptyNote: (r) => (florida(r) ? 'GEICO left basic personal injury protection empty: pick it yourself.' : null) },
      { q: 'PipOptions', ask: 'PIP Options', control: 'select', name: 'PIP options', ...pipKept('the PIP options') },
      { q: 'ExcludedWorkLoss', ask: 'Excluded Work Loss', control: 'select', name: 'Excluded work loss', ...pipKept('excluded work loss') },
      // A vehicle's coverage rows: its year, make and model name them (scope 'vehicle'), and each
      // step takes the row naming its unit, never the row at its position. Comprehensive, collision
      // and fire and theft list the trailers among the vehicles (`trailers`: a 4-vehicle FL quote
      // with a 2016 Great Dane, 2026-10-28, shifted the fifth row out of reach); rental and road
      // service only the motor vehicles. TNI's comprehensive and collision are $1,000 deductibles
      // (physicalDamageSource); the rest are the agent's.
      ...ROW_COVERAGES.map(/** @returns {CarrierRule} */ ([suffix, name]) => (['COMP', 'COLL'].includes(suffix)
        ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', trailers: true, tni: 'geico.comp-coll', name, kind: 'choice', source: physicalDamageSource, value: () => DEDUCTIBLE, note: physicalDamageNote(name.toLowerCase()) }
        : ['ERS', 'HVRS'].includes(suffix)
          ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', tni: 'geico.road-service', name: `${name} (TNI: accepted)`, kind: 'choice', source: 'standard', value: () => ROAD_SERVICE }
          : suffix === 'FT'
            ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', trailers: true, tni: 'geico.fire-theft', name: `${name} (TNI: ${FIRE_THEFT})`, kind: 'choice', source: 'standard', value: () => FIRE_THEFT }
            : suffix === 'Rental'
              ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', tni: 'geico.rental', name: `${name} (TNI: ${RENTAL})`, kind: 'choice', source: physicalDamageSource, value: () => RENTAL, note: physicalDamageNote(name.toLowerCase()) }
              : suffix === 'RRWDT'
                ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', tni: 'geico.rental-downtime', name: `${name} (TNI: ${DOWNTIME})`, kind: 'choice',
                  source: (r) => (downtimeMention(r) ? 'fact' : 'standard'), value: (r) => (downtimeMention(r) ? null : DOWNTIME), note: downtimeNote }
                : { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', name, source: 'fact' })).map(withNeeds),
      // The same customization questions as on the vehicle form, per vehicle. Found by their text:
      // their rows don't name the vehicle, so with several vehicles they are the agent's.
      { q: 'CustomizationValue', ask: 'What is the total value of the customizations or modifications to the vehicle?', path: 'operations.equipVehicle', scope: 'vehicle', tni: 'geico.customizations', name: 'Customization value (the attached equipment value, else TNI: 0)',
        kind: 'money', source: valueSource(noEquipValue), value: customizationValue, note: customizationValueNote },
      { ask: 'How much would this vehicle be worth without customizations or modifications?', path: 'vehicles[].value', scope: 'vehicle', name: 'Vehicle value without customizations', kind: 'money', note: valueNote('vehicle', vehicleOf) },
      // Motor truck cargo. The stems name other things than they ask: "…BusinessDocument…" is
      // household goods or ginned cotton, "…MobileHomes…" also business documents and securities.
      { field: 'GiveMtcEligibleRequireCoverageYesNo', ask: 'Does the customer require Motor Truck Cargo Coverage?', path: 'coverage.cargo', name: 'Motor truck cargo wanted', kind: 'bool', note: cargoNote },
      // TNI's No unless the intake's class or haul names them (W43-23).
      { field: 'GiveMtcRequireCoverageForMobileHomesYesNo', ask: 'Does the customer require coverage for mobile or modular homes or buildings, business documents, or non-negotiable securities?',
        tni: 'geico.cargo-questions', name: 'Cargo: mobile homes, business documents or securities (TNI: No unless the intake names them)', kind: 'bool', ...cargoNo(MOBILE_HOMES, 'mobile or modular homes, business documents or securities') },
      // A household goods mover hauls household goods: Yes. Otherwise TNI's No (W43-30), unless the
      // intake's class, haul or notes mention household goods, household moving or cotton: then the agent's.
      { field: 'GiveMtcRequireCoverageForBusinessDocumentYesNo', ask: 'Will the customer be hauling household goods or cotton that was ginned within 72 hours?',
        tni: 'geico.household-goods', name: 'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover; TNI: No unless the intake mentions them)',
        kind: 'bool', source: householdSource, value: household, note: householdNote },
      { field: 'GiveMtcDoesTransportLiveAnimalsYesNo', tni: 'geico.cargo-questions', name: 'Cargo: live animals (TNI: No unless the intake names them)', kind: 'bool', ...cargoNo(LIVE_ANIMALS, 'live animals') },
      { field: 'GiveMtcRequireCoverageForRefrigerationBreakdownYesNo', ask: 'Does the customer require refrigeration breakdown coverage?', path: 'coverage.reeferBreakdown', tni: 'geico.reefer-breakdown', name: 'Refrigeration breakdown (Yes with a reefer)', kind: 'bool',
        source: reeferSource, value: reeferBreakdown, note: reeferNote },
      // Up to four, from what they haul (TNI, as on Progressive: W43-23); with no match, the AI may
      // suggest one for the agent's approval (not a client fact: no manualOnly).
      { field: 'GiveMtcHaulingCommoditiesCollect', ask: 'Select up to four commodities the customer hauls the most', name: 'Cargo commodities', kind: 'choice',
        source: 'derived', value: commodities,
        note: (r) => (commodities(r) ? null : carPartsMixedNote(r) ?? `Pick up to four commodities yourself${r.operations.whatHaul ? `: the intake says they haul ${quote(r.operations.whatHaul)}` : ''}.`) },
      { q: 'CargoLimit', ask: 'Motor Truck Cargo', control: 'select', name: 'Motor truck cargo limit and deductible', kind: 'choice', source: cargoLimitSource, value: cargoChoice, note: cargoLimitNote },
      // Trailer interchange's card (FL live run, 2026-10-28), opened when the intake asks for it
      // (openInterchange): TNI's answers (util.js, general.trailer-interchange). Without the request
      // every one but the first is the agent's (a fact, never Luna's).
      { field: 'GiveTrailerInterchangeEligibleRequireCoverageYesNo', ask: 'Does the customer need Trailer Interchange Coverage?', path: 'trailerInfo.interchange', name: 'Trailer interchange', kind: 'bool' },
      { field: 'GiveTrailerInterchangeAgreementYesNo', ask: 'Does the customer have a trailer interchange agreement?', name: 'Trailer interchange agreement (the intake\'s Yes)', kind: 'bool',
        source: (r) => (interchangeRequested(r) ? 'derived' : 'fact'), value: () => true, note: interchangeUnrequested },
      { field: 'GiveTrailerInterchangeAgreementProvideOnRequestYesNo', ask: 'Does the customer agree to provide the trailer interchange agreement upon request?', tni: 'general.trailer-interchange', name: 'Trailer interchange agreement provided on request (TNI: Yes)', kind: 'bool',
        source: (r) => (interchangeRequested(r) ? 'standard' : 'fact'), value: () => true, note: interchangeUnrequested },
      { field: 'GiveTrailerInterchangeNumberOfTrailers', ask: 'How many non-owned trailers will the customer haul?', tni: 'general.trailer-interchange', name: 'Non-owned trailers hauled (TNI\'s default 1, to confirm)', kind: 'choice',
        source: (r) => (interchangeRequested(r) ? 'standard' : 'fact'), value: () => INTERCHANGE_TRAILERS, note: interchangeUnrequested, warn: interchangeCountWarn },
      // From the intake's trailer type, never its hitch (TNI, 2026-10-28: the run's Gooseneck hitch
      // isn't the trailer).
      { field: 'GiveTrailerInterchangeCommonTrailerType', ask: 'Select most common trailer type', name: 'Most common trailer type (the intake\'s trailer type, to confirm)', kind: 'choice',
        source: (r) => (interchangeType(r) ? 'derived' : 'fact'), value: interchangeType, note: interchangeTypeNote, warn: interchangeTypeWarn },
      { q: 'TrailerInterchangeLimit', ask: 'Trailer Interchange', control: 'select', tni: 'general.trailer-interchange', name: 'Trailer interchange limit (the intake\'s, or the next one up, with a $1,000 deductible)', kind: 'choice',
        source: (r) => interchangeLimitSource(r, INTERCHANGE_LIMITS), value: interchangeLimit, note: (r) => interchangeLimitNote(r, INTERCHANGE_LIMITS, 'GEICO'),
        warn: (r) => interchangeLimitRaised(r, INTERCHANGE_LIMITS, 'GEICO') },
      // Hired and non-owned autos: interchange or rented trailers don't make them Yes.
      fact('GiveHiredCoverageRequired', 'Hired auto coverage'),
      fact('GiveHiredAutoCostGreaterThanThreshold', 'Hired auto cost over GEICO\'s threshold'),
      fact('GiveHiredAutoCoverageNeeded', 'Hired auto coverage needed'),
      fact('GiveBrokeredAnyTrips', 'Brokered trips'),
      fact('GiveHasOperatedAsFreightBrokerOrForwarder', 'Operated as a freight broker or forwarder'),
      fact('GiveIsIntermodalEndorsementRequired', 'Intermodal (UIIA) endorsement'),
      fact('GiveNonOwnedAutoLiability', 'Non-owned auto liability'),
      fact('GiveNonOwnedVehicleUsedInBusiness', 'Non-owned vehicles used in the business'),
      fact('GiveNonOwnedTrailerPdEligibleRequireCoverageYesNo', 'Non-owned trailer physical damage'),
      { field: 'GiveMotorTruckGeneralLiabilityCoverageRequired', ask: 'Does the customer need Motor Truck General Liability?', path: 'coverage.gl', name: 'Motor truck general liability wanted', kind: 'bool' },
      // Its follow-ups: TNI's answers on every carrier (TNI, 2026-10-28; util.js glAnswer, general.gl),
      // opened when the intake asks for GL (openGl).
      { field: 'GiveIncomeOnlyFromTruckingOperation', ask: 'Does all of the customer\'s income come from their for-hire trucking operations?', name: 'GL: all income from for-hire trucking (TNI: Yes)', kind: 'bool', ...glAnswer(true) },
      { field: 'GiveOperateFromWarehouseOrOtherAccessiblePremises', ask: 'Does the customer operate a warehouse, facility, or other premises that their customers have access to?', name: 'GL: premises customers visit (TNI: No)', kind: 'bool', ...glAnswer(false) },
      { field: 'GiveInvolvedInAnySetupOrInstallation', ask: 'Does the customer\'s business do any setup or installation?', name: 'GL: setup or installation (TNI: No)', kind: 'bool', ...glAnswer(false) },
      { field: 'GiveOperateOrInvolvedInAnyWayForOilGasProduction', name: 'GL: oil and gas production (TNI: No unless the intake mentions oil or gas work)', kind: 'bool', ...GL_OIL_GAS },
      { q: 'GeneralLiabilityLimit', ask: 'Motor Truck General Liability', control: 'select', name: 'Motor truck general liability limit', kind: 'choice', source: 'derived', value: glLimit, note: glLimitNote },
    ]),
  ]),
};
