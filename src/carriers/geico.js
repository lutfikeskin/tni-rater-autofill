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
// Phase 1: the agent clicks Next on every step, opens each vehicle, trailer and driver form, makes
// the coverage choices and clicks Recalculate on Quote & Coverages, and prints the quote proposal
// there. The quote stops at Quote & Coverages: Final Quote Details leads to MVR & CLUE, which orders
// paid reports (stopSteps: nothing is filled or clicked there). The fill clicks no button.

import { owner, ownerDobNote as noOwnerDob } from './progressive.js';
import { isLongHaul, intakeNotes, otherNotes, ntlMention, parseRadius } from '../normalize.js';
import { noPriorInsurance, priorPolicyExpired, ownerIsDriver, companyName, companyStructure, companyStructureWarn, companyStructureNote } from '../util.js';

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
const STOP_AT_QUOTE = 'TNI stops GEICO quotes at Quote & Coverages: go back there and print the quote proposal.';

// The forms of one step, by a question only that form asks.
// - The vehicle form's first question, on all four FL vehicle forms and the NE one (absent on the
//   trailer form): its id's render number is also the form's identity.
const VEHICLE_FORM = { field: 'YesNoPreQuoteHaveFullVinActivity', unit: 'vehicles' };
// - The trailer form's type list ("Which of the following best describes the customer's trailer?",
//   NE); the vehicle form's reads "…vehicle?". On 2026-10 NE the truck's year went into it.
const TRAILER_FORM = { field: 'GiveOtherVehicleType', label: '\\btrailer\\b', unit: 'trailers' };
// - Add Driver's relationship question; the form GEICO adds for an owner who drives doesn't ask it.
const ADD_DRIVER_FORM = { field: 'GiveDriverRelationshipToBusiness', unit: 'drivers' };
const OWNER_DRIVER_FORM = { field: 'GiveDriverRelationshipToBusiness' };
// - The owner's identity again, with their Social Security number (FL capture 007, after Business
//   & Owner Info's Next, under the title of Vehicles).
const OWNER_CHECK = { field: 'GiveSocialSecurityNumber' };

// A step's rules (the whole step, or one form of it with `form`).
const on = (steps, form, rules) => rules.map((rule) => ({ steps: [].concat(steps), ...form, ...rule }));
// Facts the intake doesn't supply are the agent's (plan.js: `source: 'fact'` is never filled); with
// no note the panel says "<name> isn't on the intake: answer it yourself."
const fact = (field, name, more = {}) => ({ field, name, source: 'fact', ...more });
const quote = (v, n = 60) => `"${String(v).trim().slice(0, n)}"`;

// --- Business ----------------------------------------------------------------------------------

// GEICO's ZIP boxes take 5 digits: a ZIP+4 is cut to its ZIP (12345-6789), anything else is the
// agent's. A different ZIP already on the page (the gateway's, GEICO's own) is kept and flagged.
const zip5 = (r) => String(r.garaging?.zip ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)?.[1] ?? null;
const zipNote = (r) => (r.garaging?.zip && !zip5(r) ? `The intake's ZIP ${quote(r.garaging.zip)} isn't a 5-digit ZIP: enter it yourself.` : null);

// "Does the customer have a USDOT Number registered to themselves or their business?" Yes with a
// number; No only when the intake says none is coming within 60 days and there is no MC number.
// "Not yet, but the customer has applied for one." is never derived: a number expected within 60
// days doesn't say one was applied for.
const dotStatus = (r) => (r.applicant.dot ? 'Yes' : !r.applicant.mc && r.applicant.mcDotWithin60Days === false ? 'No' : null);
const dotStatusNote = (r) => (dotStatus(r) ? null
  : r.applicant.mc ? 'The intake has an MC number but no USDOT number: answer it yourself.'
    : r.applicant.mcDotWithin60Days === true ? 'The intake says a USDOT or MC number is coming within 60 days; whether the customer has applied for one is yours to answer.'
      : 'The intake has no USDOT number and doesn\'t say whether one is coming: answer it yourself.');
const dotNumberNote = (r) => (r.applicant.dot && !/^\d+$/.test(r.applicant.dot) ? 'The intake\'s USDOT number isn\'t digits only: enter it yourself.' : null);

// "Does the customer's business have a current GEICO commercial auto policy?" from the intake's
// current-insurance row. No for no prior insurance, a personal auto policy, or a commercial auto
// policy with another carrier; Yes for a current GEICO commercial auto policy. A blank section, an
// expired or undated GEICO policy, or another kind of policy (GL, cargo) is the agent's:
// Progressive's reading of a blank section as No is Progressive's.
const prior = (r) => r.priorInsurance?.[0] ?? null;
const commercialAuto = (p) => /commercial\s+auto/i.test(p?.type ?? '');
const currentGeico = (r) => {
  const p = prior(r);
  if (!p) return null;
  if (noPriorInsurance(p) || /personal\s+auto/i.test(p.type ?? '')) return false;
  if (!p.carrier) return null;
  if (!/\bgeico\b/i.test(p.carrier)) return commercialAuto(p) ? false : null;
  return commercialAuto(p) && p.expiration && !priorPolicyExpired(r, p) ? true : null;
};
const currentGeicoNote = (r) => (currentGeico(r) != null ? null
  : !prior(r) ? 'The intake\'s current insurance section is blank: answer it yourself.'
    : 'The intake\'s current insurance doesn\'t show whether there is a current GEICO commercial auto policy: answer it yourself.');

const HAULED = (r) => [r.operations.businessClass && `the business class is ${quote(r.operations.businessClass)}`,
  r.operations.whatHaul && `they haul ${quote(r.operations.whatHaul)}`].filter(Boolean).join(' and ');
const describeNote = (what) => (r) => `${what} is yours to pick${HAULED(r) ? ` (on the intake ${HAULED(r)})` : ''}.`;

const teamNote = (r) => (typeof r.operations.teamDriving === 'boolean' ? null
  : 'The intake doesn\'t answer team driving or slip seating (intakes before 2026-10-02 don\'t ask it): answer it yourself.');
const placardNote = (r) => (typeof r.operations.hazPlacard === 'boolean' ? null
  : r.operations.hazmat === true ? 'The intake says they haul hazardous material but doesn\'t answer the placard question: answer it yourself.'
    : 'The intake doesn\'t answer the hazardous material placard question: answer it yourself.');

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
const filingType = (r) => {
  const f = r.operations.filingsRequired;
  if (f === false) return 'Neither';
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
const filingBoxes = (r) => (r.operations.filingsRequired === true && which(r) && !ONLY_FR.test(which(r))
  ? { federal: federalLiability(which(r)) || null, state: STATE_FILING.test(which(r)) || null } : { federal: null, state: null });
const filingsNote = (r) => {
  const f = r.operations.filingsRequired;
  if (f === true && ONLY_FR.test(which(r))) return `The intake names only ${quote(which(r), 40)}, which GEICO doesn't count as a filing here: answer it yourself.`;
  return f == null && which(r) ? `The intake leaves "filings required" blank but names filings (${quote(which(r), 40)}): answer it yourself.` : null;
};

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
// An owner fact from their driver row: none when the intake says the owner doesn't drive or names
// no driver as the owner (the agent's, never another driver's).
const ownerRowNote = (what) => (r) => (owner(r).driver ? null
  : r.applicant.ownerDrives === false ? `The intake says the owner doesn't drive, so their ${what} isn't on it: answer it yourself.`
    : `The owner isn't matched to a driver on the intake, so their ${what} isn't known: answer it yourself.`);
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
// The owner's date of birth (owner().dob: the matched driver's, or the first of several drivers
// matching the owner's name; never another driver's: TNI, 2026-10-20), as on Progressive and AmWINS,
// with their note when there is none. A blank owner box has no name to match, which their note
// would quote as "".
const noOwnerName = (r) => !String(r.applicant.owner1 ?? '').trim();
const ownerDobNote = (r) => (!owner(r).dob && r.applicant.ownerDrives !== false && noOwnerName(r)
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

// The intake's phone, in both of GEICO's phone boxes (owner and business); a number that isn't a
// 10-digit US number stays the agent's.
const phoneNote = (r) => (r.applicant.phone && !/^\(\d{3}\) \d{3}-\d{4}$/.test(r.applicant.phone) ? 'The intake\'s phone isn\'t a 10-digit number: enter it yourself.' : null);
const ownerDrivesNote = (r) => (typeof r.applicant.ownerDrives === 'boolean' ? null : 'The intake doesn\'t say whether the owner drives: answer it yourself.');

// The business street: GEICO's box offers its own address suggestions, whose list hasn't been
// recorded open, so the street is the agent's to enter and pick, with the intake's quoted.
const streetNote = (r) => (r.garaging?.street
  ? `Enter the business street yourself and pick GEICO's suggestion: the intake has ${quote([r.garaging.street, r.garaging.unit].filter(Boolean).join(' '))}.`
  : 'The intake has no street: enter the business address yourself.');

// The unit ("Apt 5", "Suite 200", "#12", "Lot 7", "Trlr 3"), as GEICO's Unit Number and Unit Type.
// A unit without a number, or without a word naming its kind ("#12"), is the agent's; no unit on
// the intake leaves both boxes as they are.
const UNIT_TYPES = { apt: 'Apartment', apartment: 'Apartment', unit: 'Unit', ste: 'Suite', suite: 'Suite', lot: 'Lot',
  bldg: 'Building', building: 'Building', rm: 'Room', room: 'Room', trlr: 'Trailer' };
const unitText = (r) => String(r.garaging?.unit ?? '').trim();
const unitParts = (r) => {
  const m = unitText(r).match(/^(?:([a-z]+)\.?\s*)?#?\s*([\w-]*\d[\w-]*)$/i);
  return m ? { type: m[1] ? UNIT_TYPES[m[1].toLowerCase()] ?? null : null, number: m[2] } : { type: null, number: null };
};
const noUnit = (r) => !unitText(r);
const unitNumberNote = (r) => (unitText(r) && !unitParts(r).number ? `The intake's unit ${quote(unitText(r))} has no number for GEICO's Unit Number box: enter it yourself.` : null);
const unitTypeNote = (r) => (unitText(r) && !unitParts(r).type ? `The intake's unit ${quote(unitText(r))} doesn't say which kind it is (apartment, suite, lot…): pick it yourself.` : null);

// Shown on Business & Owner Info, and again with the owner's Social Security number (OWNER_CHECK).
const OWNER_IDENTITY = [
  { field: 'GiveBusinessName', ask: 'What is the customer\'s business name?', path: 'applicant.name', name: 'Business name (company, else the owner)', source: 'derived', value: businessName },
  { field: 'GiveFirstName', ask: 'Business Owner First Name', name: 'Owner first name', source: 'derived', value: ownerFirst, note: (r) => (ownerFirst(r)?.length > MAX_NAME ? nameNote(ownerFirst(r), 'owner\'s first name') : null) },
  { field: 'GiveLastName', ask: 'Business Owner Last Name', name: 'Owner last name', source: 'derived', value: ownerLast, note: (r) => (ownerLast(r)?.length > MAX_NAME ? nameNote(ownerLast(r), 'owner\'s last name') : null) },
  { field: 'GiveDateOfBirth', ask: 'Date of Birth', name: 'Owner date of birth', kind: 'date', source: 'derived', clientFact: true, value: (r) => owner(r).dob, note: ownerDobNote },
  { field: 'GiveStreet', name: 'Business street', source: 'fact', note: streetNote },
  { field: 'GiveUnitNumber', ask: 'Unit Number', path: 'garaging.unit', name: 'Business unit number', source: 'derived', value: (r) => unitParts(r).number, ignore: noUnit, note: unitNumberNote },
  { field: 'GiveUnitType', ask: 'Unit Type', path: 'garaging.unit', name: 'Business unit type', kind: 'choice', source: 'derived', value: (r) => unitParts(r).type, ignore: noUnit, note: unitTypeNote },
  { field: 'GiveZip', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: 'Business ZIP', source: 'derived', value: zip5, note: zipNote },
  { field: 'GiveCity', ask: 'City', path: 'garaging.city', name: 'Business city', kind: 'choice' },
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
// one of its four other vans, and a Semi Truck is GEICO's Tractor. Any other type stays the
// agent's pick.
const CARGO_VAN = /^(?:cargo\s+)?van$/i;
const SEMI_TRUCK = /^semi[\s-]*truck$/i;
const vehicleType = (r, a) => {
  const type = String(vehicleOf(r, a)?.type ?? '').trim();
  return CARGO_VAN.test(type) ? 'Delivery Van' : SEMI_TRUCK.test(type) ? 'Tractor' : null;
};
const valueNote = (unit, of) => (r, a) => {
  const v = of(r, a)?.value;
  return v != null && typeof v !== 'number' ? `The intake's ${unit} value ${quote(v)} isn't a dollar amount: enter it yourself.` : null;
};

// Customizations (GEICO's tooltip: parts and equipment attached to the vehicle) are the intake's
// attached equipment value, one answer for all the vehicles. $0 is No for every vehicle; a value is
// Yes, and the amount itself, only with one vehicle (or trailer): with several, which one carries it
// isn't on the intake. None (blank, or one the intake reader couldn't read) is TNI's standard No
// (2026-10-21, as Progressive's and AmWINS' no-equipment standards).
const severalVehicles = (r) => (r.vehicles?.length ?? 0) > 1;
const noEquipValue = (r) => r.operations?.equipVehicle == null;
const customization = (r) => (r.operations?.equipVehicle === 0 || noEquipValue(r) ? false : r.operations?.equipVehicle > 0 && !severalVehicles(r) ? true : null);
const customizationNote = (r) => (r.operations?.equipVehicle > 0 && severalVehicles(r)
  ? `The intake gives one attached equipment value ($${r.operations.equipVehicle.toLocaleString('en-US')}) for ${r.vehicles.length} vehicles: answer whether this vehicle has customizations yourself.` : null);
const customizationValue = (r) => (r.operations?.equipVehicle === 0 ? 0
  : r.operations?.equipVehicle > 0 && (r.vehicles?.length ?? 0) === 1 ? r.operations.equipVehicle : null);
const customizationValueNote = (r) => (r.operations?.equipVehicle > 0 && severalVehicles(r)
  ? `The intake gives one attached equipment value ($${r.operations.equipVehicle.toLocaleString('en-US')}) for ${r.vehicles.length} vehicles: enter this vehicle's yourself.`
  : noEquipValue(r) ? 'The intake has no attached equipment value (or one that couldn\'t be read): enter it yourself.' : null);
const trailerCustomizationValue = (r) => (r.trailerInfo?.equipTrailer === 0 ? 0
  : r.trailerInfo?.equipTrailer > 0 && (r.trailers?.length ?? 0) === 1 ? r.trailerInfo.equipTrailer : null);
const trailerCustomizationNote = (r) => (r.trailerInfo?.equipTrailer > 0 && (r.trailers?.length ?? 0) > 1
  ? `The intake gives one trailer equipment value ($${r.trailerInfo.equipTrailer.toLocaleString('en-US')}) for ${r.trailers.length} trailers: enter this trailer's yourself.`
  : r.trailerInfo?.equipTrailer == null ? 'The intake has no trailer equipment value (or one that couldn\'t be read): answer it yourself.' : null);

// Comprehensive and collision: TNI's standard (2026-10-21) is to add them, each with a $1,000
// deductible, on every vehicle and trailer, unless the intake's notes say the client doesn't want
// physical damage ("no comp/coll", "no physical damage", "liability only"): then they are the
// agent's, with the line quoted.
const NO_PHYSICAL_DAMAGE = /\bno\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?|pd)\b|\bliability\s+only\b|\bwithout\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?)\b|\b(?:doesn'?t|does not|don'?t|do not)\s+(?:want|need)\s+(?:comp(?:rehensive)?|coll(?:ision)?|phys(?:ical)?\s*dam(?:age)?)\b/i;
const noPhysicalDamage = (r) => String(otherNotes(r) ?? '').split('\n').map((s) => s.trim()).find((s) => NO_PHYSICAL_DAMAGE.test(s))?.slice(0, 80) ?? null;
const physicalDamageNote = (what) => (r) => (noPhysicalDamage(r) ? `The intake's notes say ${quote(noPhysicalDamage(r), 80)}: answer ${what} yourself.` : null);
const physicalDamageSource = (r) => (noPhysicalDamage(r) ? 'fact' : 'standard');
const DEDUCTIBLE = '$1,000 deductible';

// Farthest one-way distance: the intake's radius in miles, as GEICO's band; long haul ("Unlimited",
// OTR, 48 states) is 501 miles, "More than 500". The FL list starts at 101-200: a band the page
// doesn't offer fails to the agent, never the lowest one offered. An open radius ("500+", "over
// 300"; the reader keeps only its number) is a lower bound: from 500 up it is "More than 500", any
// other is the agent's. Miles the agent entered on Check intake count as written.
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
const parking = (unit) => [
  { field: 'GiveStreet', q: `GiveStreet.${unit}`, ask: `Where does the customer usually park their ${unit} when not in use?`, name: `Where the ${unit} is parked: street (as GEICO has it)`, ignore: true,
    emptyNote: (r) => `GEICO left where the ${unit} is parked empty: enter it yourself${r.garaging?.street ? ` (the intake's garaging street is ${quote(r.garaging.street)})` : ''}.` },
  { field: 'GiveZip', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: `Where the ${unit} is parked: ZIP`, source: 'derived', value: zip5, note: zipNote },
  { field: 'GiveCity', ask: 'City', path: 'garaging.city', name: `Where the ${unit} is parked: city`, kind: 'choice' },
];

// --- Drivers -----------------------------------------------------------------------------------

const driverOf = (r, a) => r.drivers?.[a.drivers ?? 0] ?? null;
// An Add Driver form while the panel's driver is the owner, whom GEICO already lists as a driver
// (Business & Owner Info: the owner drives): filling it would add the owner twice. The panel's
// picker starts on the first driver, often the owner.
const ownerListedNote = (r, a) => (r.applicant.ownerDrives === true && !!owner(r).driver && owner(r).driver === driverOf(r, a)
  ? 'The panel\'s driver is the owner, whom GEICO already lists: pick the driver this form is for in the panel, then Fill again.' : null);
const driverNote = (more) => (r, a) => ownerListedNote(r, a) ?? (more ? more(r, a) : null);
// "What is their relationship to the business?": Owner for a driver who is one of the intake's
// owners; any other driver is TNI's standard Employee (2026-10-21).
const isOwner = (r, d) => !!d && (ownerIsDriver(r.applicant.owner1, d) || ownerIsDriver(r.applicant.owner2, d));
const relationship = (r, a) => (!driverOf(r, a) ? null : isOwner(r, driverOf(r, a)) ? 'Owner' : 'Employee');
const relationshipSource = (r, a) => (driverOf(r, a) && !isOwner(r, driverOf(r, a)) ? 'standard' : 'derived');
const relationshipNote = (r, a) => (relationship(r, a) ? null : 'The intake has no driver for this form: answer it yourself.');
// SR-22: the intake's one answer for the business. No is No for every driver; Yes only when GEICO
// lists one driver: on the owner's form, the owner matched to the intake's only driver; on Add
// Driver, the intake's only driver when the owner doesn't drive. Otherwise (several drivers, or the
// owner listed besides the intake's driver) which one needs it isn't on the intake.
const onlyDriver = (r) => ((r.drivers?.length ?? 0) === 1 ? r.drivers[0] : null);
const sr22 = (yes) => (r) => (r.operations.needSr22 === false ? false : r.operations.needSr22 === true && yes(r) ? true : null);
const sr22Owner = sr22((r) => !!onlyDriver(r) && owner(r).driver === onlyDriver(r));
const sr22Driver = sr22((r) => !!onlyDriver(r) && r.applicant.ownerDrives === false);
const sr22Note = (value) => (r) => (r.operations.needSr22 !== true || value(r) != null ? null
  : (r.drivers?.length ?? 0) > 1 ? `The intake says an SR-22 is needed but not for which of the ${r.drivers.length} drivers: answer it for this driver yourself.`
    : 'The intake says an SR-22 is needed but not for which of the drivers GEICO lists (the owner and the intake\'s driver): answer it for this driver yourself.');
const excludedWarn = (r, a) => (driverOf(r, a)?.excluded === true
  ? 'The intake marks this driver to be excluded, and GEICO asks nothing about it here: handle the exclusion yourself.' : null);
const dobNote = (r, a) => (driverOf(r, a)?.dob && !DATE.test(driverOf(r, a).dob) ? 'This driver\'s date of birth on the intake isn\'t a valid date: enter it yourself.' : null);

// --- Additional business info ------------------------------------------------------------------

// "How many years has this business been operating?" from the intake's years in business (this
// year minus the year established). None is the agent's: AmWINS' New Venture standard is AmWINS'.
const startBucket = (n) => (!Number.isInteger(n) || n < 0 ? null
  : n < 1 ? 'Less than 1' : n === 1 ? '1' : n === 2 ? '2' : n <= 6 ? '3-6' : '7+');

// "Does the customer currently have personal or commercial auto insurance?" Yes for a current auto
// policy on the intake (commercial or personal, with an expiration date not passed), No for no prior
// insurance. A blank section, an expired or undated policy, or a GL / cargo / other row is the
// agent's; "deployed" is never derived.
const AUTO = /^(commercial|personal)\s+auto$/i;
const currentAuto = (r) => {
  const p = prior(r);
  if (!p) return null;
  if (noPriorInsurance(p)) return 'No';
  if (!AUTO.test(String(p.type ?? '').trim())) return null;
  return DATE.test(p.expiration ?? '') && !priorPolicyExpired(r, p) ? 'Yes' : null;
};
// "How many employees does the customer's business have…?" TNI (2026-10-21): the intake's drivers
// other than the owner(s), as GEICO's band. No drivers on the intake is the agent's.
const employees = (r) => {
  if (!r.drivers?.length) return null;
  const n = r.drivers.filter((d) => !isOwner(r, d)).length;
  return n === 0 ? 'None' : n === 1 ? '1' : n <= 3 ? '2-3' : n <= 5 ? '4-5' : n <= 10 ? '6-10' : n <= 20 ? '11-20' : '21+';
};
// "How long has the customer been with their current auto insurance company?" TNI (2026-10-21):
// 1-3 Years when the intake shows a current auto policy (proof of prior insurance); otherwise the
// agent's.
const yearsWithInsurer = (r) => (currentAuto(r) === 'Yes' ? '1-3 Years' : null);
const currentAutoNote = (r) => (currentAuto(r) != null ? null
  : !prior(r) ? 'The intake\'s current insurance section is blank: answer it yourself.'
    : prior(r).expiration && priorPolicyExpired(r, prior(r)) ? 'The intake\'s current policy has expired: answer it yourself.'
      : 'The intake\'s current insurance doesn\'t show a current auto policy: answer it yourself.');
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

// Non-trucking liability: set by the agent (coverage.ntl), or mentioned in the claims box or notes
// and not yet answered (Progressive's reading, docs/architecture.md: no NTL path has been seen
// live). Either way GEICO's liability coverage and its limit are the agent's.
const ntlUndecided = (r) => r.coverage?.ntl == null && (!!ntlMention(intakeNotes(r)) || r.claims?.aiNtl === true);
const ntlNote = (r) => (r.coverage?.ntl === true ? 'Non-trucking liability quote: pick GEICO\'s liability coverage and limit yourself.'
  : ntlUndecided(r) ? 'The claims box or notes mention non-trucking liability: set it to Yes or No on Check intake, then fill this page again.' : null);
// "Liability Coverage": Bodily Injury and Property Damage Liability for an intake asking for auto
// liability (Yes, or a limit with the box blank). No, NTL, or nothing is the agent's; "I don't need
// Liability Coverage" is never picked.
const liabilityType = (r) => {
  const a = String(r.coverage?.autoLiability ?? '').trim();
  if (ntlNote(r) || /non-?trucking/i.test(a) || /^no$/i.test(a)) return null;
  return /^yes$/i.test(a) || (!a && r.coverage?.autoLiabLimit) ? 'Bodily Injury and Property Damage Liability' : null;
};
const liabilityNote = (r) => ntlNote(r) ?? (liabilityType(r) ? null
  : /non-?trucking/i.test(r.coverage?.autoLiability ?? '') ? 'The intake asks for non-trucking liability: pick GEICO\'s liability coverage yourself.'
    : /^no$/i.test(String(r.coverage?.autoLiability ?? '').trim()) ? 'The intake says no auto liability: answer it yourself.'
      : 'The intake doesn\'t say which liability coverage: answer it yourself.');

// Florida (the garaging state): GEICO offers Basic Personal Injury Protection, which TNI takes over
// medical payments (2026-10-21): Medical Payments is Not Included, and the PIP lists (one choice
// each in FL) are kept as GEICO has them. Elsewhere all of them are the agent's.
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
// matched by its amounts). No deductible on the intake is the agent's: Progressive's $1,000 is
// Progressive's. A pair GEICO doesn't list ($100K/$5K) finds no option and stays the agent's.
const cargoChoice = (r) => (r.coverage?.cargo === true && r.coverage.cargoLimit && r.coverage.cargoDeductible
  ? `$${r.coverage.cargoLimit}/$${r.coverage.cargoDeductible}` : null);
const cargoLimitNote = (r) => (cargoChoice(r) ? null
  : r.coverage?.cargo === true ? 'Cargo is requested without both a limit and a deductible on the intake: choose them yourself.'
    : 'The intake doesn\'t ask for cargo coverage: answer it yourself.');
const cargoNote = (r) => (typeof r.coverage?.cargo !== 'boolean' && r.coverage?.cargoLimit
  ? 'The intake gives a cargo limit but doesn\'t tick cargo coverage: answer it yourself.' : null);
const isMover = (r) => /^household\s+goods\s+mover$/i.test(String(r.operations.businessClass ?? '').trim());

// Motor truck general liability: the intake's GL request (coverage.gl, never coverage.hasGl, GL the
// client already has), and its limit when GEICO lists it. TNI's $1M/$2M default for a request
// without a limit is recorded for Progressive only.
const GL_LIMITS = { '$1M/$2M': '$1,000,000/$2,000,000 aggregate' };
const glLimit = (r) => (r.coverage?.gl === true ? GL_LIMITS[String(r.coverage.glLimit ?? '').trim()] ?? null : null);
const glLimitNote = (r) => (glLimit(r) ? null
  : r.coverage?.gl !== true ? 'The intake doesn\'t ask for general liability: answer it yourself.'
    : r.coverage.glLimit ? `The intake asks for a ${quote(r.coverage.glLimit, 20)} general liability limit, which GEICO doesn't list: choose it yourself.`
      : 'General liability is requested without a limit on the intake: choose it yourself.');

// A vehicle's rows on Quote & Coverages, one per vehicle, by the coverage their list's id ends in:
// comprehensive and collision are TNI's $1,000 deductibles, the rest the agent's.
const ROW_COVERAGES = [['COMP', 'Comprehensive'], ['COLL', 'Collision'], ['FT', 'Fire and theft'], ['Rental', 'Rental reimbursement'],
  ['RRWDT', 'Rental reimbursement with downtime'], ['ERS', 'Emergency road service'], ['HVRS', 'Heavy vehicle road service']];

export const geico = {
  id: 'geico',
  name: 'GEICO',
  hosts: [/(^|\.)geico\.com$/],
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
  // The generic label rules misfired on GEICO's pages (FL: the first driver in the owner's boxes,
  // the intake's phone in the mobile-homes cargo question).
  useGenericRules: false,
  // TNI's GEICO standards were set on a for-hire freight quote (FL, 2026-10-21): an expediter or a
  // freight hauler, as Progressive's. Any other class fills them in review mode (plan.js).
  supportedClasses: [/expedit/i, /^(?:general\s+)?freight\s+haul(?:er|ing)$/i],
  // GEICO pre-selects answers everywhere (No on cargo, hired autos, non-owned and general
  // liability, Yes on the registered state, a value in every coverage list): ours replace them, as
  // on Progressive; anything the agent changed is left alone.
  replaceChoices: true,
  // Steps with one vehicle's (or trailer's) form, and one driver's: the agent's own edits there are
  // kept per unit (the panel's active vehicle or driver).
  vehicleSteps: [VEHICLES],
  driverSteps: [DRIVERS],
  // The intake driver GEICO lists itself (the owner who drives, added on Business & Owner Info): an
  // Add Driver form is never theirs (sidepanel pickUnitForm). -1 for none.
  listedDriver: (r) => (r.applicant?.ownerDrives === true && owner(r).driver ? r.drivers.indexOf(owner(r).driver) : -1),
  // Steps that are the agent's: nothing is filled or clicked there (not even on Fill this page), and
  // the AI assistant isn't asked.
  // The quote stops at Quote & Coverages (TNI, 2026-10-21): going on leads to MVR & CLUE, whose
  // reports cost the agency and are run only once the client shows interest in the offer.
  stopSteps: {
    'Final Quote Details': `Final Quote Details is yours: nothing is filled or clicked on this step. ${STOP_AT_QUOTE}`,
    'MVR & CLUE': `MVR & CLUE orders driving and claims reports, which cost the agency: that is yours. Nothing is filled or clicked on this step. ${STOP_AT_QUOTE}`,
    'Payment Information': 'Payment Information is yours: nothing is filled or clicked on this step.',
  },
  // What the panel says on a step the fill still answers.
  stepNotes: {
    [COVERAGES]: 'Make the coverage choices, click Recalculate, then Print Quote Proposal. Stop here: Next leads to MVR & CLUE, whose reports cost the agency; run them only once the client is interested.',
  },
  // GEICO requotes when a coverage changes, and puts back its own choices when the agent backs out
  // (FL live run, 2026-10-21: every follow-up fill set the liability limit again, and GEICO redrew the
  // quote each time, losing the agent's choices). On Quote & Coverages: no follow-up fill (only the
  // step's first fill and Fill this page), no button clicked (the agent's Recalculate), and an answer
  // the fill gave that the page shows otherwise since is kept, flagged (pagekit `takenBack`).
  // Its follow-up fills run only for questions it draws (FL live run 2, 2026-10-21: each cargo
  // question waited for the agent's Fill, and GEICO's own No to cargo stood until then), never after
  // an answer or a redraw.
  newQuestionsOnlySteps: [COVERAGES],
  keepTakenBack: [COVERAGES],
  rules: [
    // --- The gateway (gateway2.geico.com) --------------------------------------------------------
    // The quote starts with the ZIP in the Start New Quote window, over any gateway page (and the
    // USDOT check beside it on the dashboard); the gateway's own controls (search, coverage boxes,
    // alerts) are never answered. Never on the quote, whose own ZIP is GiveInitialZipCode.
    { notPages: GATEWAY_OFF, selector: '#start-quote-zip', name: 'Start quote: ZIP (the garaging ZIP)', path: 'garaging.zip', source: 'derived', value: zip5, note: zipNote },
    { notPages: GATEWAY_OFF, selector: '#dashboard-usdot', name: 'Start quote: USDOT number', path: 'applicant.dot', ignore: (r) => !r.applicant.dot, note: dotNumberNote },
    { notPages: GATEWAY_OFF, selector: 'input[name="header-search-type"], #search-input-id, input[name="lob-selection"], [id^="alerts-pref"]', name: 'Gateway dashboard (not the quote)', q: 'gatewayDashboard', ignore: true },
    // --- Business Class & USDOT ----------------------------------------------------------------
    ...on(BUSINESS_CLASS, {}, [
      { field: 'GiveInitialZipCode', ask: '5-Digit ZIP Code', path: 'garaging.zip', name: 'ZIP code (the garaging ZIP)', source: 'derived', value: zip5, note: zipNote },
      { field: 'GiveCurrentGeicoCommercialAutoPolicyYesNo', ask: 'Does the customer\'s business have a current GEICO commercial auto policy?', name: 'Current GEICO commercial auto policy',
        kind: 'bool', source: 'derived', clientFact: true, value: currentGeico, note: currentGeicoNote },
      { field: 'GiveDepartmentOfTransportationNumber', ask: 'What is the customer\'s USDOT number?', path: 'applicant.dot', ignore: (r) => !r.applicant.dot, note: dotNumberNote },
      // The business description lists 1,599 kinds of business (too many for the AI assistant), the
      // more detailed one 26: the agent's picks, never matched by words ("Freight Hauler" isn't
      // "Freight Forwarder").
      { field: 'GivePrimaryBusinessDescription', ask: 'Please choose what best describes the customer\'s business.', name: 'Business description (the agent\'s pick)', note: describeNote('What best describes the business') },
      { field: 'GiveSecondaryBusinessDescription', ask: 'Please give us a little more information about what the customer\'s business does.', name: 'More about the business (the agent\'s pick)', note: describeNote('The more detailed description') },
      // GEICO is the first carrier mapped to ask it. Intakes from before the question are null:
      // unanswered, not No.
      { field: 'TeamDrivingOrSlipSeatingYesNo', ask: 'Do any of your customer\'s vehicles require team driving or slip seating to keep the vehicle continuously moving?', path: 'operations.teamDriving', name: 'Team driving or slip seating', kind: 'bool', note: teamNote },
      // The intake's answer; blank is the agent's (Progressive's blank-is-No is Progressive's standard).
      { field: 'GiveAnyVehicleNeedHazardousMaterialPlacardYesNo', ask: 'Do any of the customer\'s vehicles or loads require a hazardous material placard?', path: 'operations.hazPlacard', name: 'Hazardous material placard', kind: 'bool', note: placardNote },
      // Not shown on the captured quotes (what reveals it isn't known).
      { field: 'GiveFilingType', name: 'State or federal filing', kind: 'choice', source: 'derived', clientFact: true, value: filingType, note: filingTypeNote },
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
        kind: 'choice', source: 'derived', clientFact: true, value: dotStatus, note: dotStatusNote },
      // "USDOT Information: Is this the customer's business?", under GEICO's record of the number:
      // the agent checks it against the client (Progressive's standard Yes is Progressive's).
      { field: 'GiveExtendUsDotVerifyBusinessAddress', name: 'USDOT record is the client\'s business', source: 'attestation',
        note: 'Check GEICO\'s USDOT record against the client\'s business, then answer it yourself.' },
    ]),

    // --- Business & Owner Info -----------------------------------------------------------------
    ...on(BUSINESS_OWNER, {}, [
      ...OWNER_IDENTITY,
      // Prefilled by GEICO; never the application date or the prior policy's expiration.
      { field: 'GiveEffectiveDate', name: 'Coverage start date (as GEICO has it)', ignore: true,
        emptyNote: 'GEICO left the coverage start date empty, and it isn\'t on the intake: pick it yourself.' },
      { field: 'GiveMaritalStatus', ask: 'Marital Status', name: 'Owner marital status', kind: 'choice', source: 'derived', clientFact: true,
        value: (r) => owner(r).driver?.maritalStatus ?? null, note: ownerRowNote('marital status') },
      { field: 'GivePhoneNumber', ask: 'Please confirm the owner\'s phone number', path: 'applicant.phone', name: 'Owner phone (the intake\'s phone)', note: phoneNote },
      { field: 'GiveBusinessPhoneNumber', ask: 'Please confirm the business phone number', path: 'applicant.phone', name: 'Business phone', note: phoneNote },
      { field: 'GiveEmail', ask: 'What\'s the customer\'s email address?', path: 'applicant.email', name: 'Customer email' },
      { field: 'GiveBusinessOwnershipType', ask: 'Business ownership type:', name: 'Business ownership type (from the company name)', kind: 'choice', source: 'derived', clientFact: true, value: ownershipType, note: ownershipNote, warn: ownershipWarn },
      // Blank is not Yes because the owner is a listed driver.
      { field: 'GiveOwnerActiveDriverStatusYesNo', path: 'applicant.ownerDrives', name: 'Owner is a driver', kind: 'bool', note: ownerDrivesNote },
    ]),
    // Never filled, wherever GEICO asks it (and never logged: typed values never are).
    fact('GiveSocialSecurityNumber', 'Owner Social Security number (never filled)', { steps: [BUSINESS_OWNER, VEHICLES], ask: 'Business Owner Social Security Number',
      note: 'The owner\'s Social Security number is never filled: enter it yourself only if the client gave it.' }),

    // --- Vehicles ------------------------------------------------------------------------------
    // The owner's identity again, with the Social Security number.
    ...on(VEHICLES, { whenShown: OWNER_CHECK }, OWNER_IDENTITY),
    ...on(VEHICLES, {}, [
      // The chooser behind Add Vehicle or Trailer: the agent adds each unit.
      fact('GiveVehicleOrTrailer', 'Vehicle or trailer to add', { ask: 'What would the customer like to add?', note: 'Pick Vehicle or Trailer for the unit you are adding yourself.' }),
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
      { field: 'GiveOtherVehicleType', waitFor: afterDecode, ask: 'Which of the following best describes the customer\'s vehicle?', name: 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)', kind: 'choice',
        source: (r, a) => (vehicleType(r, a) ? 'standard' : null), value: vehicleType, note: (r, a) => (vehicleType(r, a) ? null : typeNote('vehicle', vehicleOf)(r, a)) },
      { field: 'GiveAnyVehicleCustomizationYesNo', waitFor: afterDecode, ask: 'Does the customer have any customizations?', path: 'operations.equipVehicle', name: 'Customizations (from the attached equipment value)',
        kind: 'bool', source: (r) => (noEquipValue(r) ? 'standard' : 'derived'), clientFact: true, value: customization, note: customizationNote },
      { field: 'GiveTotalCustomizationValue', waitFor: afterDecode, ask: 'What is the total value of the customizations or modifications to the vehicle?', path: 'operations.equipVehicle', name: 'Customization value (the attached equipment value)',
        kind: 'money', source: 'derived', value: customizationValue, note: customizationValueNote },
      // Its value without the customizations: the intake's vehicle value (today's, never cost new).
      { field: 'GiveCostExcludingPermanentlyAttachedEquipment', waitFor: afterDecode, path: 'vehicles[].value', name: 'Vehicle value without customizations', kind: 'money', note: valueNote('vehicle', vehicleOf) },
      fact('GiveDetailedCostNew', 'Cost new', { note: 'What the vehicle cost new isn\'t on the intake (its value there is today\'s): answer it yourself.' }),
      // Also sets GEICO's lowest liability limit: never worked out from the type or model. TNI
      // (2026-10-21): GEICO's own band, from the VIN, is kept.
      { field: 'GiveGrossVehicleWeight', ask: 'What is the Gross Vehicle Weight (GVW)?', name: 'Gross vehicle weight (as GEICO has it)', ignore: true,
        emptyNote: 'GEICO left the gross vehicle weight empty, and it isn\'t on the intake: answer it from the registration.' },
      { field: 'GiveCommercialVehicleCompCollision', waitFor: afterDecode, ask: 'Would the customer like to add comprehensive or collision coverage?', name: 'Comprehensive or collision wanted (TNI: Yes)',
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
      { field: 'GiveCommercialVehicleCompCollision', q: 'GiveCommercialVehicleCompCollision.trailer', ask: 'Would the customer like to add comprehensive or collision coverage?', name: 'Trailer comprehensive or collision wanted (TNI: Yes)',
        kind: 'bool', source: physicalDamageSource, value: () => true, note: physicalDamageNote('whether to add comprehensive or collision on this trailer') },
      { field: 'GiveTotalCustomizationValue', q: 'GiveTotalCustomizationValue.trailer', path: 'trailerInfo.equipTrailer', name: 'Trailer customization value (the trailer equipment value)',
        kind: 'money', source: 'derived', value: trailerCustomizationValue, note: trailerCustomizationNote },
      { field: 'GiveCostExcludingPermanentlyAttachedEquipment', path: 'trailers[].value', name: 'Trailer value without customizations', kind: 'money', note: valueNote('trailer', trailerOf) },
      ...parking('trailer'),
      { field: 'GiveFarthestOneWayDistance', q: 'GiveFarthestOneWayDistance.trailer', name: 'Trailer farthest one-way distance (from the radius)', kind: 'choice', source: 'derived', value: distanceBand, note: distanceNote },
      fact('GiveRegisteredStateYesNo', 'Trailer registered in the garaging state', { q: 'GiveRegisteredStateYesNo.trailer' }),
    ]),

    // --- Drivers & Incidents -------------------------------------------------------------------
    // The driver GEICO adds for an owner who drives (named after the owner): the owner's answers,
    // from their driver row, never the panel's active driver.
    ...on(DRIVERS, { unlessShown: OWNER_DRIVER_FORM }, [
      { field: 'GiveDriverLicenseState', q: 'GiveDriverLicenseState.owner', name: 'Owner\'s license state', kind: 'state', source: 'derived', value: (r) => owner(r).driver?.licenseState ?? null, note: ownerRowNote('license state') },
      { field: 'GiveCertificateOfFinancialResponsibilityDriverYesNo', ask: 'We just need a little more info about this driver. Do they need a Certificate of Financial Responsibility or SR-22?',
        path: 'operations.needSr22', name: 'SR-22 (the owner)', kind: 'bool', source: 'derived', value: sr22Owner, note: sr22Note(sr22Owner) },
      { field: 'CommercialDriverLicense', q: 'CommercialDriverLicense.owner', ask: 'Does this driver have a CDL?', name: 'Owner has a CDL', kind: 'bool', source: 'derived',
        value: (r) => (typeof owner(r).driver?.cdl === 'boolean' ? owner(r).driver.cdl : null), note: ownerRowNote('CDL answer') },
    ]),
    // Add Driver: the panel's active driver.
    ...on(DRIVERS, { whenShown: ADD_DRIVER_FORM }, [
      { field: 'GiveFirstName', ask: 'First Name', path: 'drivers[].first', name: 'Driver first name', note: driverNote((r, a) => (driverOf(r, a)?.first?.length > MAX_NAME ? nameNote(driverOf(r, a).first, 'driver\'s first name') : null)), warn: excludedWarn },
      { field: 'GiveLastName', ask: 'Last Name', path: 'drivers[].last', name: 'Driver last name', note: driverNote((r, a) => (driverOf(r, a)?.last?.length > MAX_NAME ? nameNote(driverOf(r, a).last, 'driver\'s last name') : null)) },
      // GEICO is the first carrier mapped with a suffix box.
      { field: 'GiveDriverSuffix', ask: 'Suffix', path: 'drivers[].suffix', name: 'Driver suffix', kind: 'choice', optional: true, note: driverNote() },
      { field: 'GiveDateOfBirth', ask: 'Date of Birth', path: 'drivers[].dob', name: 'Driver date of birth', kind: 'date', note: driverNote(dobNote) },
      { field: 'GiveDriverLicenseState', ask: 'Driver\'s License State', path: 'drivers[].licenseState', name: 'Driver license state', kind: 'state', note: driverNote() },
      { field: 'GiveDriverRelationshipToBusiness', ask: 'What is their relationship to the business?', name: 'Driver\'s relationship to the business (Owner, else Employee)', kind: 'choice', source: relationshipSource, clientFact: true,
        value: relationship, note: driverNote(relationshipNote) },
      { field: 'CommercialDriverLicense', ask: 'Does this driver have a CDL?', path: 'drivers[].cdl', name: 'Driver has a CDL', kind: 'bool', note: driverNote() },
      // Hidden on the captured Add Driver form.
      { field: 'GiveCertificateOfFinancialResponsibilityDriverYesNo', path: 'operations.needSr22', name: 'SR-22 (this driver)', kind: 'bool', source: 'derived', value: sr22Driver, note: driverNote(sr22Note(sr22Driver)) },
    ]),

    // --- Additional Business Info --------------------------------------------------------------
    ...on(MORE_BUSINESS, {}, [
      { field: 'GiveBusinessStartDate', ask: 'How many years has this business been operating?', path: 'applicant.yearsInBusiness', name: 'Years in business', kind: 'choice', source: 'derived',
        value: (r) => startBucket(r.applicant.yearsInBusiness), note: (r) => (startBucket(r.applicant.yearsInBusiness) == null ? 'The intake has no years in business (or year established): answer it yourself.' : null) },
      { field: 'GiveNumberOfEmployees', ask: 'How many employees does the customer\'s business have, including part-time employees?', name: 'Number of employees (the drivers besides the owner)', kind: 'choice',
        source: (r) => (employees(r) ? 'standard' : 'fact'), value: employees, note: (r) => (employees(r) ? null : 'The intake lists no drivers: answer how many employees the business has yourself.') },
      { field: 'GiveCurrentAutoInsuranceStatus', ask: 'Does the customer currently have personal or commercial auto insurance?', name: 'Currently has auto insurance', kind: 'choice', source: 'derived', clientFact: true, value: currentAuto, note: currentAutoNote },
      fact('GiveInsurancePriorToBeingDeployed', 'Insured before being deployed'),
      { field: 'GiveYearsWithCurrentAutoInsurer', ask: 'How long has the customer been with their current auto insurance company?', name: 'Years with the current auto insurer (1-3 with a current policy)', kind: 'choice',
        source: (r) => (yearsWithInsurer(r) ? 'standard' : 'fact'), value: yearsWithInsurer, note: (r) => (yearsWithInsurer(r) ? null : currentAutoNote(r) ?? 'The intake shows no current auto policy: answer it yourself.') },
      { field: 'GiveCurrentBodilyInjuryLimits', ask: 'What bodily injury limits does the customer currently have on their vehicle insurance?', path: 'priorInsurance[0].limit', name: 'Current bodily injury limits',
        kind: 'choice', source: 'derived', value: currentBi, note: currentBiNote },
      { field: 'GiveOtherLiabilityInsurance', ask: 'What kind of liability insurance does the customer currently have to cover their business?', name: 'Liability insurance the business has (None unless the notes say)',
        kind: 'choice', source: otherLiabilitySource, clientFact: true, value: otherLiability, note: otherLiabilityNote },
      // TNI (2026-10-21): No for every intake.
      { field: 'GiveInsuredOrWaiverYesNo', ask: 'Does the customer need to add a named additional insured or a designated insured? Or do they need a named waiver of subrogation?', name: 'Named additional insured or waiver of subrogation (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasContractForBlanketAiEndorsement', ask: 'Does the customer have a contract that requires a blanket additional insured endorsement?', name: 'Blanket additional insured by contract (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasContractForBlanketWosEndorsement', name: 'Blanket waiver of subrogation by contract (TNI: No)', kind: 'bool', source: 'standard', value: () => false },
      { field: 'GiveHasFilingsYesNo', ask: 'Is the customer required to provide proof of insurance/filings to a state or federal agency?', path: 'operations.filingsRequired', name: 'Filings required', kind: 'bool', note: filingsNote },
      // Shown after Yes (FL): only a box the intake names is ticked.
      { field: 'AddFilings.FederalLiability', ask: 'Federal Liability (includes MCS-90)', path: 'operations.filingsWhich', name: 'Federal liability filing', kind: 'bool', source: 'derived',
        value: (r) => filingBoxes(r).federal, ignore: (r) => !filingBoxes(r).federal },
      { field: 'AddFilings.MCS90', ask: 'MCS-90', name: 'MCS-90 filing (as the page has it)', ignore: true },
      { field: 'AddFilings.StateFiling', ask: 'State', path: 'operations.filingsWhich', name: 'State filing', kind: 'bool', source: 'derived',
        value: (r) => filingBoxes(r).state, ignore: (r) => !filingBoxes(r).state },
    ]),

    // --- Quote & Coverages ---------------------------------------------------------------------
    ...on(COVERAGES, {}, [
      fact('PolicyTermSliderCollect', 'Policy term'),
      // Two groups (pay in full and installments, each with its own name): one rule each.
      ...[1, 2].map(() => fact('GivePayPlanV2', 'Payment plan', { each: true, note: 'The payment plan is yours to pick with the client.' })),
      { q: 'LiabilityCoverage', ask: 'Liability Coverage', control: 'select', name: 'Liability coverage', kind: 'choice', source: 'derived', value: liabilityType, note: liabilityNote },
      // The intake's limit, by its amount ($1M CSL is "$1,000,000 Combined Single Limit"). A split
      // limit, State Minimum or one GEICO doesn't offer finds no option: the agent's, never the next one up.
      { ask: 'Bodily Injury or Combined Single Limit Liability', control: 'select', path: 'coverage.autoLiabLimit', name: 'Liability limit', kind: 'choice',
        note: (r) => ntlNote(r) ?? (liabilityType(r) ? null : 'Pick the liability limit yourself, with the liability coverage.') },
      { q: 'UninsuredMotorist', ask: 'Uninsured Motorist Bodily Injury (includes Underinsured)', control: 'select', name: 'Uninsured motorist bodily injury', source: 'fact' },
      // FL: one choice each, kept as GEICO has them (pipKept).
      { q: 'Stacked', ask: 'Is Stacked', control: 'select', name: 'Stacked uninsured motorist', ...pipKept('stacked uninsured motorist') },
      { q: 'MedicalPayments', ask: 'Medical Payments (MED)', control: 'select', name: 'Medical payments (FL: Not Included, PIP instead)', kind: 'choice',
        source: (r) => (florida(r) ? 'standard' : 'fact'), value: (r) => (florida(r) ? 'Not Included' : null) },
      { q: 'BasicPip', ask: 'Basic Personal Injury Protection', control: 'select', name: 'Basic personal injury protection', ...pipKept('basic personal injury protection') },
      { q: 'PipOptions', ask: 'PIP Options', control: 'select', name: 'PIP options', ...pipKept('the PIP options') },
      { q: 'ExcludedWorkLoss', ask: 'Excluded Work Loss', control: 'select', name: 'Excluded work loss', ...pipKept('excluded work loss') },
      // A vehicle's coverage rows: its year, make and model name them (scope 'vehicle'). TNI's
      // comprehensive and collision are $1,000 deductibles (physicalDamageSource); the rest are the agent's.
      ...ROW_COVERAGES.map(([suffix, name]) => (['COMP', 'COLL'].includes(suffix)
        ? { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', name, kind: 'choice', source: physicalDamageSource, value: () => DEDUCTIBLE, note: physicalDamageNote(name.toLowerCase()) }
        : { q: suffix, selector: `[id$="_${suffix}"]`, scope: 'vehicle', name, source: 'fact' })),
      // The same customization questions as on the vehicle form, per vehicle. Found by their text:
      // their rows don't name the vehicle, so with several vehicles they are the agent's.
      { q: 'CustomizationValue', ask: 'What is the total value of the customizations or modifications to the vehicle?', path: 'operations.equipVehicle', scope: 'vehicle', name: 'Customization value (the attached equipment value)',
        kind: 'money', source: 'derived', value: customizationValue, note: customizationValueNote },
      { ask: 'How much would this vehicle be worth without customizations or modifications?', path: 'vehicles[].value', scope: 'vehicle', name: 'Vehicle value without customizations', kind: 'money', note: valueNote('vehicle', vehicleOf) },
      // Motor truck cargo. The stems name other things than they ask: "…BusinessDocument…" is
      // household goods or ginned cotton, "…MobileHomes…" also business documents and securities.
      { field: 'GiveMtcEligibleRequireCoverageYesNo', ask: 'Does the customer require Motor Truck Cargo Coverage?', path: 'coverage.cargo', name: 'Motor truck cargo wanted', kind: 'bool', note: cargoNote },
      fact('GiveMtcRequireCoverageForMobileHomesYesNo', 'Cargo: mobile homes, business documents or securities', { ask: 'Does the customer require coverage for mobile or modular homes or buildings, business documents, or non-negotiable securities?' }),
      // A household goods mover hauls household goods: Yes. Anything else is the agent's (No isn't derivable).
      { field: 'GiveMtcRequireCoverageForBusinessDocumentYesNo', ask: 'Will the customer be hauling household goods or cotton that was ginned within 72 hours?', name: 'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover)',
        kind: 'bool', source: (r) => (isMover(r) ? 'derived' : 'fact'), value: (r) => (isMover(r) ? true : null),
        note: (r) => (isMover(r) ? null : 'Whether they haul household goods or cotton ginned within 72 hours isn\'t on the intake: answer it yourself.') },
      fact('GiveMtcDoesTransportLiveAnimalsYesNo', 'Cargo: live animals'),
      { field: 'GiveMtcRequireCoverageForRefrigerationBreakdownYesNo', ask: 'Does the customer require refrigeration breakdown coverage?', path: 'coverage.reeferBreakdown', name: 'Refrigeration breakdown (Yes with a reefer)', kind: 'bool',
        source: reeferSource, value: reeferBreakdown, note: reeferNote },
      // A list the fill can't set (several picks): the agent's.
      fact('GiveMtcHaulingCommoditiesCollect', 'Cargo commodities', { ask: 'Select up to four commodities the customer hauls the most',
        note: (r) => `Pick up to four commodities yourself${r.operations.whatHaul ? `: the intake says they haul ${quote(r.operations.whatHaul)}` : ''}.` }),
      { q: 'CargoLimit', ask: 'Motor Truck Cargo', control: 'select', name: 'Motor truck cargo limit and deductible', kind: 'choice', source: 'derived', value: cargoChoice, note: cargoLimitNote },
      { field: 'GiveTrailerInterchangeEligibleRequireCoverageYesNo', path: 'trailerInfo.interchange', name: 'Trailer interchange', kind: 'bool' },
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
      // Its follow-ups: Progressive's standard answers are Progressive's.
      fact('GiveIncomeOnlyFromTruckingOperation', 'GL: all income from for-hire trucking', { ask: 'Does all of the customer\'s income come from their for-hire trucking operations?' }),
      fact('GiveOperateFromWarehouseOrOtherAccessiblePremises', 'GL: premises customers visit', { ask: 'Does the customer operate a warehouse, facility, or other premises that their customers have access to?' }),
      fact('GiveInvolvedInAnySetupOrInstallation', 'GL: setup or installation', { ask: 'Does the customer\'s business do any setup or installation?' }),
      fact('GiveOperateOrInvolvedInAnyWayForOilGasProduction', 'GL: oil and gas production'),
      { q: 'GeneralLiabilityLimit', ask: 'Motor Truck General Liability', control: 'select', name: 'Motor truck general liability limit', kind: 'choice', source: 'derived', value: glLimit, note: glLimitNote },
    ]),
  // A rule without a record path is named by its data-model name (its path geico.q<name>, which
  // logs and reviews read), with a suffix where one name is two questions.
  ].map((rule) => (rule.path || rule.q || !rule.field ? rule : { ...rule, q: rule.field })),
};
