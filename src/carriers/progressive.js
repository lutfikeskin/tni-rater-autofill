// Progressive commercial auto, ForAgentsOnly (clpolicy.foragentsonly.com).
//
// The quote flow is an ExtJS 6 + Duck Creek ("DCT") single-page app. A rule finds its question by
// what it is, on its page (onPage): the field's data-model name (`field`, Duck Creek's fieldref,
// "RiskInput.VIN"), else the question's text (`ask`, or the `label` regex). Never by the question
// id in the element id: Progressive renumbered every question on 2026-10-07 (Agent Code 18F became
// 1C6) and ids kept from before named other questions. `q` is the id the rule was written from,
// kept only as the rule's name (its path progressive.q<q>, which logs and reviews use).
// `field` names come from saved pages (layouts/fao-html, IA, 2026-10-02); the rest find their
// question by its text until a layout records its fieldref. Mapped from live MD for-hire
// expediter quotes (captures/progressive/). Questions that exist only in other states or for
// other products are skipped when absent. Unmapped questions require agent review; only
// the narrow, reviewed label rules below are used as fallbacks.
//
// Checked against a full saved IA quote (2026-10-02, layouts/fao-html and fao-pdf, kept local):
// every question shown on Business Owner Info, Most Common Vehicles, Add Vehicle, Vehicle and
// Driver Summary, Add Driver, More About Business, Coverages & Rates and Change Payment Plan has
// a rule here (53 of 53). The saved pages hold no combo option lists (Progressive loads them at
// runtime) and no hidden follow-up questions (it builds those on its server when revealed).
//
// Rules either read a record path, or compute a value with `value(record, active)` when
// Progressive words the answer differently from the intake form. `note` rules are questions the
// agent must answer themselves; they're marked, never filled.
//
// Follow-up questions the intake doesn't cover use TNI's standard answers (the agent's own
// choices on live quotes). The agent changes them for the exceptions.

import { priorPolicyExpired, ownerIsDriver } from '../util.js';
import { ntlMention } from '../normalize.js';

// Values that Progressive asks the agent to attest to must come from an explicit intake field.
// Keep these helpers conservative: an absent value is a review item, not a reason to guess.
const explicitBoolean = (record, path) => {
  const [head, ...tail] = path.split('.');
  let value = record?.[head];
  for (const part of tail) value = value?.[part];
  return typeof value === 'boolean' ? value : null;
};

// The business owner, matched to their driver row (for date of birth and a clean name split).
export function owner(r) {
  const full = r.applicant.owner1 ?? '';
  const nameKey = (name) => (String(name ?? '').toLowerCase().match(/\p{L}+/gu) ?? []).sort().join(' ');
  const fullMatches = r.drivers.filter((d) => nameKey(full) && nameKey(`${d.first ?? ''} ${d.middle ?? ''} ${d.last ?? ''}`) === nameKey(full));
  // The same surname, or a word of a two-word surname with a matching first name (util.js).
  const lastMatches = r.drivers.filter((d) => ownerIsDriver(full, d));
  // Some intakes repeat the first name in the sole driver's last-name box. Only connect
  // that DOB when the intake explicitly says the owner drives and the owner's first name agrees.
  const sole = r.drivers.length === 1 ? r.drivers[0] : null;
  const repeatedFirst = sole && r.applicant.ownerDrives === true && nameKey(sole.first)
    && nameKey(sole.first) === nameKey(sole.last)
    && nameKey(sole.first) === nameKey(full.split(/\s+/).slice(0, -1).join(' '));
  // The owner box sometimes holds only the first name ("IBRAHIM"): the one driver whose first
  // name starts with it is the owner.
  const firstOnly = !/\s/.test(full.trim()) && full.trim()
    ? r.drivers.filter((d) => (d.first ?? '').trim().split(/\s+/)[0].toLowerCase() === full.trim().toLowerCase()) : [];
  const driver = fullMatches.length === 1 ? fullMatches[0] : fullMatches.length ? null : lastMatches.length === 1 ? lastMatches[0]
    : repeatedFirst ? sole : firstOnly.length === 1 ? firstOnly[0] : null;
  const first = driver?.first ?? full.split(/\s+/).slice(0, -1).join(' ');
  return { driver, first: first || null, middle: driver?.middle ?? null, last: repeatedFirst ? full.split(/\s+/).at(-1) : driver?.last ?? full.split(/\s+/).at(-1) ?? null };
}

// "Is the customer currently insured with Progressive Commercial Auto?" Yes only when the
// intake's current-insurance section is a Progressive *commercial* auto policy filled out with
// the coverage (limit) and the expiration date. A Progressive personal auto policy doesn't count.
const insuredWithProgressive = (r) => {
  const p = r.priorInsurance[0];
  return !!(p && /commercial\s+auto/i.test(p.type ?? '') && /progressive/i.test(p.carrier ?? '') && p.limit && p.expiration && !priorPolicyExpired(r, p));
};

// After a USDOT lookup Progressive offers the registered business name / address as a choice,
// next to "Enter a different …". Agents pick the registered one. Without a USDOT number there is
// no such choice: the manual boxes are the only option and get the intake's values (below and
// in the reviewed address rules).
const registered = (prefer) => ({ kind: 'pick-not', value: () => ({ not: '^enter a different', prefer }), ignore: (r) => !r.applicant.dot });
const businessNames = (r) => [r.applicant.name || r.applicant.owner1].filter(Boolean);

// The intake's vehicle value, only when it's a dollar amount. Anything else ("N/A", "about
// 40k") goes to the agent with the intake's text, rather than being typed and cleared.
const vehicleValueNote = (r, a) => {
  const v = r.vehicles?.[a.vehicles ?? 0]?.value;
  return v != null && typeof v !== 'number' ? `The intake's vehicle value "${v}" isn't a dollar amount: enter it yourself.` : null;
};

const loanLease = (r) => {
  const own = r.operations?.vehicleOwnership ?? '';
  return /financ|loan/i.test(own) ? 'Yes - Loan' : /leas/i.test(own) ? 'Yes - Lease' : 'No';
};

// Trailers: the intake's trailer ownership (one answer for all of them); none given is owned
// (TNI 2026-10-07). An answer that is none of these (Rented) is the agent's.
const trailerLoanLease = (r) => {
  const own = String(r.trailerInfo?.ownership ?? '').trim();
  return /financ|loan/i.test(own) ? 'Yes - Loan' : /leas/i.test(own) ? 'Yes - Lease' : !own || /^owned?$/i.test(own) ? 'No' : null;
};
const trailerOwnershipNote = (r) => (trailerLoanLease(r) == null
  ? `The intake's trailer ownership "${r.trailerInfo.ownership}" isn't owned, financed or leased: answer the loan / lease question yourself.` : null);
const trailerValueNote = (r, a) => {
  const v = r.trailers?.[a.trailers ?? 0]?.value;
  return v != null && typeof v !== 'number' ? `The intake's trailer value "${v}" isn't a dollar amount: enter it yourself.` : null;
};

// The trailer's pages carry the vehicle's data-model names (RiskInput.VIN, RiskInput.Radius…):
// the vehicle's questions are never looked for there, and the trailer's only there.
const TRAILER_PAGES = ['MostCommonTrailers', 'AddTrailer'];
const offTrailerPages = (rule) => ({ ...rule, notPages: TRAILER_PAGES });

// The quote's state is the garaging state (as the quote on Progressive's home page is started).
const isFlorida = (r) => /^(fl|florida)$/i.test(String(r.garaging?.state ?? '').trim());

// A trailer's attached equipment: the intake's amount when it gives one (not "N/A" or 0), else
// none (TNI standard: "Trailer has no equipment").
const trailerEquipment = (r) => (r.trailerInfo?.equipTrailer > 0 ? r.trailerInfo.equipTrailer : null);

// Farthest one-way distance: "Unlimited" / long haul becomes 501 miles, which picks "More than
// 500 miles". A trailer goes as far as the vehicle (TNI).
const radiusMiles = (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null);

// Always "$0 to $2,000" at TNI; the agent changes it for the rare exception.
const equipment = () => '$0 to $2,000';

const cargo = (r) => {
  const c = r.coverage;
  if (c.cargo === false) return 'Not selected';
  // No deductible on the intake: TNI's standard $1,000.
  return c.cargoLimit ? `$${c.cargoLimit}/$${c.cargoDeductible ?? 1000}` : null;
};

// What the intake calls the freight -> Progressive's commodity category and commodity.
const COMMODITIES = [
  { match: /general\s*freight/i, category: 'Consumer Goods', commodity: 'Other Consumer Goods' },
];
const commodity = (r) => COMMODITIES.find((c) => c.match.test(r.operations.whatHaul ?? '')) ?? null;

// Filings: Yes when the intake says so. On the Filings page the standard answers are "all
// vehicles on this quote" = Yes and the Federal filing; ticking Federal makes Progressive tick
// MCS-90 itself, so MCS-90 is left as the page sets it.
const filings = (r) => (r.operations.filingsRequired === true ? true : r.operations.filingsRequired === false ? false : null);
const filingsNote = (r) => (r.operations.filingsRequired === true && !r.applicant.dot
  ? 'Filings are requested but the intake has no USDOT number; Progressive may not allow filings without one.'
  : null);
const usesEld = (r) => explicitBoolean(r, 'operations.usesEld');
const eldNote = (r) => (usesEld(r) == null ? 'The intake does not answer the ELD question.' : null);
const cargoNote = (r) => r.coverage.cargo === true && !r.coverage.cargoLimit
  ? 'Cargo was requested without a limit; an agent must choose it.'
  : null;
const glNote = (r) => r.coverage.gl === true
  ? 'Progressive General Liability mappings are not validated; an agent must review this coverage manually.'
  : null;

// Comprehensive / collision: the intake's deductible when it has one, otherwise TNI's standard $1,000.
const vehicleDeductible = (r, key) => {
  const value = r.coverage?.[key];
  return value == null || value === '' ? '$1,000 Deductible' : String(value);
};

// Progressive's business type (and, for trucking, the type of trucker) for what the intake
// calls the business. Expediters are "For Hire Trucking" / "Other For-Hire Trucking".
const isExpediter = (r) => /expedit/i.test(r.operations.businessClass ?? '');
const isFreightHauler = (r) => /^(?:general\s+)?freight\s+haul(?:er|ing)$/i.test((r.operations.businessClass ?? '').trim());
const isGeneralFreight = (r) => isFreightHauler(r) && /general\s+freight/i.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);
const businessType = (r) => isExpediter(r) ? 'For Hire Trucking' : isFreightHauler(r) ? 'General Freight Hauler' : (r.operations.businessClass ?? null);
const businessAliases = (r) => isGeneralFreight(r) ? ['General Freight Trucking'] : [];
const currentlyInsured = (r) => !!r.priorInsurance?.some((p) => p.limit && p.expiration && !priorPolicyExpired(r, p));
// Once For Hire Trucking reveals this question, the agency workflow uses this subtype.
const truckerType = (r) => (isExpediter(r) ? 'Other For-Hire Trucking' : null);
// LLC / Inc / Corp in the name means a corporation; the owner-operators quoted so far without
// one were sole proprietors. Partnerships are never guessed.
const businessStructure = (r) => (/\b(llc|l\.l\.c|inc|corp|corporation|company|co)\.?$/i.test(r.applicant.name ?? '')
  ? 'Corporation or LLC / Non-Profit' : 'Individual / Sole Proprietor');

// Rates as TNI agents work it (bill plan, back, Recalculate, Print) unless GL is requested: then
// the bill plan is the agent's. With NTL the whole page is, Recalculate and Print too, until the
// NTL section has been seen on a live quote (an earlier bill plan visit must not let them run
// while its new questions are open).
// An NTL mention in the claims box the agent hasn't answered yet (Yes or No) is not a No: Rates
// waits for it like for NTL itself.
// Luna's NTL flag for a line the words don't catch ("bobtale", "N.T.L.") counts too (claims.aiNtl).
const ntlUndecided = (r) => r.coverage.ntl == null && (!!ntlMention(r.claims?.text) || r.claims?.aiNtl === true);
const notNtl = (r) => r.coverage.ntl !== true && !ntlUndecided(r);
const ourBillPlan = (r) => r.coverage.gl !== true && notNtl(r);

// The whole address on one line, for address boxes that offer the carrier's own suggestions.
const oneLineAddress = (r) => {
  const g = r.garaging ?? {};
  if (!g.street) return null;
  return [[g.street, g.unit].filter(Boolean).join(' '), g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
};

const PRINT_EMAIL_FAX = '^print(,? ?[/,]? ?e-?mail)?(,? ?[/,]? ?(and |or )?fax)?$';
// The link under the liability coverage that opens the Non-Trucking Liability section.
const ADD_NTL = '^add non-?trucking liability( instead)?\\??$';
// Later Rates helpers wait while an NTL added on this quote is still there after the agent set it
// back to No (until the page offers Add NTL again).
const NTL_HOLD = ['ntlStillAdded'];

// A small, reviewed label fallback for practice layouts and carrier redraws that omit a Duck
// Creek question id. Keep optional contact fields and unvalidated GL out of this list.
const SAFE_LABEL_RULES = [
  { path: 'drivers[].first', label: '^(driver )?first name$', not: 'business|company|agent|producer' },
  { path: 'drivers[].last', label: '^(driver )?last name$', not: 'business|company|agent|producer' },
  { path: 'drivers[].dob', label: 'birth|\\bdob\\b' },
  { path: 'drivers[].licenseState', label: '(driver.?s? )?(license|licence|dl) state|state of (the )?(license|licence|dl)' },
  { path: 'drivers[].licenseNumber', label: '(driver.?s? )?(license|licence|dl) (number|no|num|id)', not: 'state|year|date|status|type|class|cdl' },
  // VIN lookup owns these read-only values. Verify them against the intake when present, never
  // type over the server-decoded result.
  { path: 'vehicles[].year', label: '^(vehicle |model |truck )?year$', not: 'trailer', verifyOnly: true, notPages: TRAILER_PAGES },
  { path: 'vehicles[].make', label: '^(vehicle |truck )?make$', not: 'trailer', verifyOnly: true, notPages: TRAILER_PAGES },
  { path: 'vehicles[].model', label: '^(vehicle |truck )?model$', not: 'trailer|year', verifyOnly: true, notPages: TRAILER_PAGES },
  { path: 'vehicles[].vin', label: '\\bvin\\b|vehicle identification', not: 'trailer', notPages: TRAILER_PAGES },
  { path: 'vehicles[].value', label: 'stated (value|amount)|(vehicle|truck|unit) value|actual cash value|cost new|^value$', not: 'trailer|cargo|equipment', notPages: TRAILER_PAGES },
  { path: 'garaging.street', label: '(street|garaging|mailing|physical|business)? ?address( line)?( 1)?$|^street', not: 'e ?mail|web|\\bip\\b|2|city|state|zip' },
  { path: 'garaging.unit', label: 'address (line )?2|\\bapt\\b|apartment|suite|\\bunit (number|no)\\b|^unit$', ignore: (r) => !r.garaging?.unit },
  { path: 'garaging.city', label: '\\bcity\\b' },
  { path: 'garaging.zip', label: '\\bzip|postal' },
  { path: 'operations.radius', label: 'radius|miles from (garag|home)' },
  { path: 'operations.hazPlacard', label: 'placard' },
  { path: 'operations.personalUse', label: 'personal use' },
  { path: 'coverage.autoLiabLimit', label: '(auto |bodily injury |combined single |csl )?liability limit|^bi limit|combined single limit', not: 'general|cargo' },
  { path: 'priorInsurance[0].limit', label: '(prior|current|previous).*liability.*limit', ignore: (r) => !currentlyInsured(r) },
  { path: 'priorInsurance[0].expiration', label: '(prior|current|previous).*expir|policy expiration', ignore: (r) => !currentlyInsured(r) },
  { name: 'Fire / theft additional coverage', label: 'fire\\s*/?\\s*theft', kind: 'choice', value: () => 'Not selected' },
];

// Vehicle picker tile for the intake's vehicle type (a regex on the tile's text). Types not listed
// (Tanker, Dump Truck, Other) are the agent's to pick until we have seen their tiles.
const VEHICLE_TILES = {
  Van: '^Cargo Van$',
  'Semi Truck': '^Truck Tractor$',
  'Box Truck': '^Box Truck$',
  'Pickup Truck': '^Pickup Truck$',
  Flatbed: '^Flatbed Truck$',
  // TNI: a reefer tile only when the business class says Reefer too. Its exact name isn't known yet.
  'Reefer Truck': 'reefer|refrigerat',
};
// Trailer picker tile for the intake's trailer type (Most Common Trailers, TNI 2026-10-07: Dry
// Freight, Flatbed, Refrigerated Dry Freight, Gooseneck, Other / Not Listed). Enclosed, Tanker,
// Lowboy, Step Deck and Other are the agent's to pick.
const TRAILER_TILES = {
  Flatbed: '^Flatbed Trailer$',
  'Dry Van': '^Dry Freight Trailer$',
  Reefer: '^Refrigerated Dry Freight$',
};
const trailerTile = (r, a) => TRAILER_TILES[r.trailers?.[a.trailers ?? 0]?.type] ?? null;
const trailerTileNote = (r, a) => {
  const type = r.trailers?.[a.trailers ?? 0]?.type;
  if (!type) return 'The intake has no trailer type for this trailer: pick it yourself.';
  return TRAILER_TILES[type]
    ? `No tile on this page matches the intake's ${type} trailer: pick it yourself.`
    : `${type} isn't matched to a Progressive trailer tile yet: pick it yourself.`;
};

const isReefer = (r) => /^reefer$/i.test((r.operations.businessClass ?? '').trim());
const vehicleTile = (r, a) => {
  const type = r.vehicles[a.vehicles ?? 0]?.type;
  if (type === 'Reefer Truck' && !isReefer(r)) return null;
  return VEHICLE_TILES[type] ?? null;
};
// Shown when no tile was clicked for this vehicle, so the agent knows to pick it.
const vehicleTileNote = (r, a) => {
  const type = r.vehicles[a.vehicles ?? 0]?.type;
  if (!type) return 'The intake has no vehicle type for this vehicle: pick it yourself.';
  if (type === 'Reefer Truck' && !isReefer(r)) return 'The intake says Reefer Truck but its business class is not Reefer: pick the vehicle yourself.';
  return VEHICLE_TILES[type]
    ? `No tile on this page matches the intake's ${type}: pick the vehicle yourself.`
    : `${type} isn't matched to a Progressive tile yet: pick the vehicle yourself.`;
};

// A page's questions (its pageName): each question is looked for on its own page only, so "City" on
// Business Owner Info and on NoHit are two questions, and a page's label rules stay on it.
const onPage = (page, rules) => rules.map((rule) => ({ page, ...rule }));

export const progressive = {
  id: 'progressive',
  name: 'Progressive',
  hosts: [/(^|\.)foragentsonly\.com$/, /(^|\.)progressive\.com$/],
  // ExtJS components are only reachable from the page's own JavaScript world.
  world: 'MAIN',
  // Only the quote flow is filled automatically (not the home or quote-search pages).
  autoFillUrl: /\/Express\/Default\.aspx/i,
  // Live Progressive questions are mapped explicitly below. Generic label fallbacks can
  // turn an unvalidated field (especially optional contact or GL fields) into an assertion.
  useGenericRules: false,
  // Progressive pre-selects some answers (filings No, $750k CSL, manual payments, rental "Not
  // selected"). Those are replaced when ours differ; anything the agent changed is left alone.
  replaceChoices: true,
  // Buttons the filler clicks, in order, each once per quote, only on its page and only once
  // every `after` field has the intended value. `unless`: skip when any of these has a value.
  // `text` is a regex on the button's text, `token` a string in its id/href/onclick.
  // Never clicked, whatever a rule says: Continue, Next, Finish, Buy, Bind, Submit, Save.
  actions: [
    { id: 'verifyDot', page: 'BusinessOwnerInfo', text: '^verify( us)?( ?dot)?( number)?$', after: ['applicant.dot'], immediate: true },
    // Vehicle summary: "Add a Vehicle" for a vehicle not entered yet (its VIN lookup not done).
    // The vehicles found by the USDOT lookup are listed there too; ours is added with Add Vehicle,
    // which sits in the "Add" menu.
    // The side panel moves the active vehicle to the next one not added yet (vehicleList below);
    // once all are added nothing is left on the page and its Continue is clicked.
    { id: 'addVehicle', page: 'VehicleSummary', text: '^add (a |another )?vehicle$|^add another$', opener: '^add$', unlessActions: ['lookupVin:vehicle'], scope: 'vehicle' },
    // Driver list: Add for each intake driver not entered yet (the side panel moves the active
    // driver, see driverList), then Continue.
    { id: 'addDriver', page: 'DriverSummary', text: '^add (a |another )?driver$|^add another$', opener: '^add$', unlessActions: ['driverEntered'], scope: 'driver' },
    // Some states (IN, OH) show the business type as a box with a Search next to it, which opens
    // the business type list (BECAPopup).
    { id: 'businessTypeSearch', page: 'BusinessOwnerInfo', text: '^search$', near: 'business type', unless: ['progressive.q36'] },
    // Two tiles matching (two reefer tiles) means it's the agent's pick.
    { id: 'vehicleTile', page: 'MostCommonVehicles', text: vehicleTile, unique: true, label: 'Vehicle type', missing: vehicleTileNote, scope: 'vehicle' },
    { id: 'lookupVin', page: 'AddVehicle', text: '^look ?up( vin)?$', after: ['vehicles[].vin'], immediate: true, scope: 'vehicle' },
    // Trailers, once every vehicle is in: Add Trailer (in the "Add" menu) for the next intake
    // trailer not entered yet (the side panel moves the active trailer, see trailerList), its tile,
    // then its Add Trailer page. When the button can't be found the agent is told, so Continue
    // never leaves an intake trailer out (TN 2026-10-07).
    { id: 'addTrailer', page: 'VehicleSummary', text: '^add (a |another )?trailer$', opener: '^add$', unlessActions: ['trailerEntered:trailer'], afterActions: (r) => (r.vehicles ?? []).map((_, i) => `lookupVin:${i}`), scope: 'trailer', label: 'Trailer', missing: 'Add the intake\'s trailer yourself (Add → Add Trailer).', doneWhen: (r, a) => [`trailerEntered:${a.trailers ?? 0}`], unfinished: 'Add Trailer was opened, but this intake trailer was never entered: add it (Add → Add Trailer) before Continue.', when: (r) => (r.trailers?.length ?? 0) > 0 },
    { id: 'trailerTile', page: 'MostCommonTrailers', text: trailerTile, unique: true, label: 'Trailer type', missing: trailerTileNote, scope: 'trailer', when: (r) => (r.trailers?.length ?? 0) > 0 },
    // Non-trucking liability, once the agent set it to Yes (a claims-box mention alone never
    // clicks it): the link under the liability coverage that opens the NTL section. First in this
    // list, so it comes before cargo. Done only when the link is gone afterwards (a click lost in a
    // redraw stays a blocker). What the section asks hasn't been seen on a live quote: its
    // questions, the bill plan and the rest of Rates are the agent's (agentPages below).
    { id: 'addNtl', page: 'CoveragesRates', text: ADD_NTL, verify: 'gone', when: (r) => r.coverage.ntl === true },
    // NTL added on this quote, then set back to No: the filler doesn't remove it. Never clicked; a
    // "needs you" item on Rates, holding the later Rates helpers, until the page offers Add NTL
    // again (the agent removed it).
    // NTL quote, or an NTL mention not answered yet: never clicked, a "needs you" item that keeps
    // Continue for the agent (the rest of Rates is theirs, or waits for their answer).
    { id: 'ntlRates', page: 'CoveragesRates', label: 'Non-trucking liability', when: (r) => r.coverage.ntl === true,
      missing: () => 'NTL quote: the rest of this page is yours (the NTL section, cargo, the bill plan, Recalculate, Print). Continue yourself when it is done.' },
    { id: 'ntlDecide', page: 'CoveragesRates', label: 'Non-trucking liability', when: ntlUndecided,
      missing: () => 'The claims box mentions NTL and Non-trucking liability isn\'t answered: set it to Yes or No on Check intake, then fill this page again.' },
    { id: 'ntlStillAdded', page: 'CoveragesRates', afterActions: ['addNtl'], resolvedBy: ADD_NTL, label: 'Non-trucking liability', when: (r) => r.coverage.ntl !== true,
      missing: () => 'NTL was added on this quote, but Non-trucking liability is no longer Yes on the intake: remove it on this page yourself, or set it back to Yes.' },
    // The "+" in the Motor Truck Cargo row (every coverage has one).
    // With NTL the cargo helpers are the agent's too (the rest of Rates is, see agentPages).
    { id: 'openCargo', page: 'CoveragesRates', heldBy: NTL_HOLD, text: '^\\+$', near: 'motor truck cargo', unless: ['progressive.q2150', 'progressive.q216F'], when: (r) => r.coverage.cargo === true && notNtl(r) },
    { id: 'addCargoCommodity', page: 'CoveragesRates', heldBy: NTL_HOLD, text: '^add( another)?( a)? commodity$', afterActions: ['openCargo'], when: (r) => r.coverage.cargo === true && notNtl(r) },
    // OK (2026-10-07): the commodity was chosen but Done didn't show until the agent chose it again
    // (the category's reload still under way): with no Done, the commodity is chosen again, once.
    { id: 'doneCargo', page: 'CoveragesRates', heldBy: NTL_HOLD, text: '^done with this coverage$', nudge: 'progressive.q216B', afterActions: ['addCargoCommodity'], after: ['progressive.q216A', 'progressive.q216B'], afterAny: ['progressive.q216F', 'progressive.q2150'], verify: 'cargoClosed', when: (r) => r.coverage.cargo === true && notNtl(r) },
    // Rates, as TNI agents work it: once cargo is added (and no GL is requested), open the bill
    // plan options, pick automatic payments there, come back (Continue), then Recalculate, then
    // Print, Email, Fax. With GL or NTL requested the agent does the rates page by hand.
    // None of the rates helpers run while the liability limit is unresolved (missing, rejected or
    // different from the intake); a limit the agent set themselves counts as resolved.
    { id: 'billPlan', page: 'CoveragesRates', heldBy: NTL_HOLD, text: '^(view )?bill(ing)?( plan)? options?$', afterActions: (r) => r.coverage.cargo ? ['doneCargo'] : [], after: ['coverage.autoLiabLimit'], afterAny: ['coverage.autoLiabLimit', 'progressive.q2150', 'progressive.q216F'], when: ourBillPlan },
    // Back from the bill plan Progressive has usually recalculated already (Recalculate is gone,
    // Print, Email, Fax is there): Recalculate only when the rates say they're out of date.
    // Recalculate and Print follow the bill plan, which waited for a resolved liability limit.
    // They don't re-check that field: back from the bill plan, the reloaded Rates page failed the
    // same check on a limit that was fine (FL and NJ runs: Print, Email, Fax never ran).
    // With GL there is no bill plan step of ours: they keep the liability check instead.
    { id: 'recalculate', page: 'CoveragesRates', heldBy: NTL_HOLD, text: '^recalculate$', after: (r) => r.coverage.gl === true ? ['coverage.autoLiabLimit'] : [], afterActions: (r) => r.coverage.gl !== true ? ['billPlan'] : [], afterPages: ['ChangePaymentPlan'], needsRecalculation: true, verify: 'premium', when: notNtl },
    // Progressive shows Print, Email, Fax (in place of Recalculate) only once the rates are
    // current, so back from the bill plan the button itself is the signal.
    { id: 'print', page: 'CoveragesRates', heldBy: NTL_HOLD, text: PRINT_EMAIL_FAX, after: (r) => r.coverage.gl === true ? ['coverage.autoLiabLimit'] : [], afterActions: (r) => r.coverage.gl !== true ? ['billPlan'] : [], afterPages: ['ChangePaymentPlan'], when: notNtl },
    // This page may have been opened by the agent or restored after a panel reload. Its own
    // document and delivery controls establish readiness; no in-memory navigation history is needed.
    // Again on every return to the page (the agent went back, changed something, and reprints).
    { id: 'printSend', page: 'PrintEmailFax', text: '^print ?/ ?send$', after: ['progressive.q32B0', 'progressive.q32CC'], verify: 'download', repeatOnReturn: true },
  ],
  // The page listing the quote's vehicles: the side panel works on the next intake vehicle not
  // added yet there, so Add Vehicle repeats until all are in, then Continue.
  vehicleList: 'VehicleSummary',
  // The pages about one vehicle, repeated for each (their Continue is per vehicle).
  vehiclePages: ['MostCommonVehicles', 'AddVehicle'],
  // Trailers are added from the same list; their pages are per trailer, and Add Trailer marks its
  // trailer entered once filled.
  trailerList: 'VehicleSummary',
  trailerPages: TRAILER_PAGES,
  trailerPage: 'AddTrailer',
  // Same for drivers: the AddDriver page marks its driver entered once filled.
  driverList: 'DriverSummary',
  driverPage: 'AddDriver',
  // Pages that need the agent whatever the intake says; the side panel says so at the top.
  agentPages: {
    // TNI (2026-10-07): an SSN only when the client gave one; the usual fix is the owner's name.
    NoHit: "Progressive couldn't verify the business owner. Adjust the owner's name: removing the middle name and keeping only the first and last name often fixes it. Check the date of birth and home address too (an SSN only if the client gave one), then Continue.",
    CoveragesRates: (r) => (r.coverage?.ntl === true
      ? 'Non-trucking liability (NTL) quote: the filler opens it with "Add Non-Trucking Liability instead?". The rest of this page is yours: answer that section, then cargo, the bill plan, Recalculate and Print.'
      : null),
  },
  // Pages where Progressive has stopped the quote. Nothing is filled or clicked there (not even on
  // Fill this page) and Luna isn't asked: the panel shows the note and the page is the agent's.
  // DeclinationNotice follows Business Owner Info when the customer already has a Progressive
  // commercial auto policy (2026-10-05; text and buttons only).
  stopPages: {
    DeclinationNotice: 'Progressive says this client already has a commercial auto policy with Progressive. The quote stops here: nothing on this page is filled or clicked. Let the client know; what to do next is yours.',
  },
  // When a page has nothing left for the agent, its Continue ("Ok, start quote." on page 1) is
  // clicked. Never on the finish/buy pages.
  // Never on NoHit either: the agent adjusts the owner's details there (agentPages).
  advance: { text: '^(continue|ok,? start quote\\.?)\\W*$', exceptPages: ['AdditionalDetails', 'SaveQuote', 'Quote', 'PrintEmailFaxConfirm', 'NoHit'] },
  rules: [
    ...SAFE_LABEL_RULES,
    // --- Named Insured and Business Overview (pageName=BusinessOwnerInfo) ---------------------
    ...onPage(['BusinessOwnerInfo', 'BECAPopup'], [
      { q: '18F', field: 'AgencyInfo.AgencyCodeAgent', ask: 'Agent Code', name: 'Agent code (preserve prefilled value)', ignore: true },
      { q: '194', field: 'PolicyInput.EffectiveDate', ask: 'When should this Progressive Commercial Auto policy start?', name: 'Policy start date (preserve prefilled value)', ignore: true },
      { q: '198', field: 'AccountInput.PGRInsuredIndicator', ask: 'Is the customer currently insured with Progressive Commercial Auto?', name: 'Currently insured with Progressive Commercial Auto', kind: 'bool', value: insuredWithProgressive },
      { q: '1CC', field: 'Warehouse.QuoteVendorCode', ask: 'Quote Vendor Code', optional: true, name: 'Quote vendor code (optional)', ignore: true },
      { q: '1ED', field: 'USDOTInput.Question', ask: 'Does the customer have a USDOT Number?', name: 'Has a USDOT number', kind: 'choice', value: (r) => {
        if (r.applicant.dot) return 'Yes - the customer has a USDOT number';
        if (r.applicant.mcDotWithin60Days === true) return 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days';
        return 'No - and the customer will not have a USDOT number';
      } },
      { q: '1F3', field: 'USDOTInput.NumberCollection', ask: 'USDOT Number associated with the customer\'s business:', path: 'applicant.dot', ignore: (r) => !r.applicant.dot },
      // Shown when Verify USDOT finds no record for the number (a brand-new USDOT): TNI's answer is Yes.
      { q: '21E', field: 'USDOTInput.SixtyDayQuestion', ask: 'Did the customer obtain their USDOT Number within the last 60 days?', name: 'USDOT obtained within the last 60 days (standard: Yes)', kind: 'bool', value: () => true, ignore: (r) => !r.applicant.dot },
      { q: '20F', ask: 'Does this USDOT Number belong to the customer\'s business?', name: 'USDOT number belongs to the business (standard: Yes)', kind: 'bool', ignore: (r) => !r.applicant.dot, value: (r) => (r.applicant.dot ? true : null), businessNames },
      { q: '22F', ask: 'Business Name', registeredName: true, name: 'Business name (USDOT record)', ...registered(), businessNames },
      { q: '277', ask: 'Business Address', name: 'Primary business address (USDOT record)', ...registered(), businessNames },
      // Always the first choice offered. When that's "Enter a different address", the address box
      // below gets the whole address and Progressive's first suggestion.
      { q: '2A5', field: 'BusinessOwnerHomeAddressInputNonShredded.AddressOptionsForPrimaryBsnsAdrs', ask: 'Home Address', name: 'Owner home address (first option)', kind: 'first-option', value: () => 'first option' },
      // Typed in whenever Progressive shows the box: without a USDOT number, and also with a brand-new
      // one the lookup can't find yet (then there's no registered name to pick).
      { q: '230', field: 'AccountInput.BusinessName', ask: 'Business Name', path: 'applicant.name', name: 'Business / sole proprietor name', value: (r) => r.applicant.name || [owner(r).first, owner(r).last].filter(Boolean).join(' ') || r.applicant.owner1 },
      { q: '233', field: 'AccountInput.DBA', ask: 'DBA Name', optional: true, name: 'DBA name (always left empty)', ignore: true },
      // Owner home address box, shown when there's no registered address to pick ("2AA" after
      // "Enter a different address", "2A9" when there's no choice at all): the whole address,
      // then Progressive's first suggestion, which fills ZIP and city. The ZIP/city rules then
      // check what it filled against the intake.
      { q: '2AA', label: '^business owner home address input', name: 'Owner home address (with suggestion)', kind: 'address-suggest', value: oneLineAddress },
      { q: '2A9', ask: 'Home Address', name: 'Owner home address (with suggestion)', kind: 'address-suggest', value: oneLineAddress },
      { q: '2AE', ask: 'ZIP Code', askAfter: 'Home Address', path: 'garaging.zip', name: 'Owner home ZIP' },
      { q: '2B0', ask: 'City', askAfter: 'Home Address', path: 'garaging.city', name: 'Owner home city' },
      // Business address boxes, when there's no registered address to pick.
      // Business street with Google's address suggestions, like the home address box: the whole
      // address, then the first suggestion, which fills ZIP and city (checked by their rules).
      { q: '27E', field: 'PrimaryBusinessAddressOutputNonShredded.StreetAddressDup', ask: 'Street Address', name: 'Business address (with suggestion)', kind: 'address-suggest', value: oneLineAddress, fallback: (r) => r.garaging?.street ?? null },
      { q: '284', field: 'PrimaryBusinessAddressInput.ZipCode', ask: 'Zip Code', askAfter: 'Street Address', path: 'garaging.zip', name: 'Business ZIP' },
      { q: '286', field: 'PrimaryBusinessAddressInput.City', ask: 'City', askAfter: 'Street Address', path: 'garaging.city', name: 'Business city' },
      // Search-style business type (IN, OH): the box itself is left alone (typing filters the list
      // away); the result list (BECAPopup q36) gets For Hire Trucking, or General Freight Trucking
      // when the list doesn't have it. Options read "<name> <description>".
      { q: '24D', ask: 'Business Type', control: 'text', each: true, name: 'Business type box (filled by the search)', ignore: true },
      { q: '1D', ask: 'Business Type', control: 'text', each: true, name: 'Business type search box', ignore: true },
      { q: '36', ask: 'Business Type Label', name: 'Business type (search list: For Hire Trucking, else General Freight Trucking)', kind: 'choice', value: () => 'For Hire Trucking', choiceAliases: () => ['General Freight Trucking'] },
      { q: '239', ask: ['Business type list', 'Business Type'], control: 'select', name: 'Business type', kind: 'choice', value: businessType, choiceAliases: businessAliases, summaryAfter: (r) => isExpediter(r) ? 'Type of Trucker' : 'How is the customer\'s business structured?' },
      { q: '22D', field: 'AccountInput.BusinessStructure', ask: 'How is the customer\'s business structured?', name: 'Business structure', kind: 'choice', value: businessStructure },
      { q: '267', field: 'AccountInput.SpecificTruckHaulContractType', ask: 'Type of Trucker', name: 'Type of trucker', kind: 'choice', value: truckerType, ignore: (r) => !isExpediter(r) },
      { q: '295', field: 'AccountInput.BusinessOwnerName', ask: 'Business Owner\'s Name', name: 'Owner first name', value: (r) => owner(r).first },
      { q: '296', field: 'AccountInput.BusinessOwnerMiddleInitial', ask: 'MIMiddle initial', optional: true, name: 'Owner middle initial', value: (r) => owner(r).middle?.[0] ?? null, ignore: true },
      { q: '297', field: 'AccountInput.BusinessOwnerLastName', ask: 'Last Name', name: 'Owner last name', value: (r) => owner(r).last },
      { q: '298', field: 'AccountInput.BusinessOwnerSuffix', ask: 'Suffix', optional: true, name: 'Owner suffix (optional)', ignore: true },
      { q: '29F', field: 'AccountInput.DriverInPolicyIndicator', label: 'is a driver on the policy$', name: 'Owner is a driver', kind: 'bool', path: 'applicant.ownerDrives' },
      { q: '2BB', field: 'AccountInput.BusinessOwnerDOB', ask: 'Date of Birth', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
      // The demonstrated workflow deliberately leaves Progressive's optional phone boxes blank.
      { q: '2DB', field: 'AccountInput.PhoneAreaCodeString', ask: 'Primary Phone Number', name: 'Phone area code (optional)', ignore: true },
      { q: '2DD', field: 'AccountInput.PhoneThreeDigitsString', ask: 'Three digit prefix of phone', name: 'Phone prefix (optional)', ignore: true },
      { q: '2DF', field: 'AccountInput.PhoneFourDigitsString', ask: 'Four digit suffix of phone', name: 'Phone line number (optional)', ignore: true },
      { q: '2F6', field: 'BCBTUBusQuestions.B53AnyVehicleRequiresHazardousPlacard', ask: 'Do any listed vehicles or the load require a hazardous material placard?', path: 'operations.hazPlacard', name: 'Hazmat placard required' },
    ]),

    // --- Owner not found by Progressive's lookup (NoHit) ----------------------------------------
    ...onPage('NoHit', [
      // The owner's details again, for a second search. The SSN is never filled.
      { q: '1B7F', field: 'NoHitCredit.FirstName', ask: 'Business Owner\'s Name', name: 'Owner first name (NoHit)', value: (r) => owner(r).first },
      { q: '1B80', field: 'NoHitCredit.MiddleInitial', ask: 'MIMiddle initial', optional: true, name: 'Owner middle initial (NoHit, optional)', ignore: true },
      { q: '1B81', field: 'NoHitCredit.LastName', ask: 'Last Name', name: 'Owner last name (NoHit)', value: (r) => owner(r).last },
      { q: '1B82', field: 'NoHitCredit.Suffix', ask: 'Suffix', optional: true, name: 'Owner suffix (NoHit, optional)', ignore: true },
      // The street line only: Progressive keeps the suite/unit (Business Owner Info's line 2) apart,
      // and the street plus unit read as a different address on every quote with a unit.
      { q: '1B84', field: 'CurrentAddress.Address1', ask: 'Home Address', name: 'Owner home address (NoHit)', value: (r) => r.garaging?.street ?? null },
      { q: '1B85', field: 'CurrentAddress.City', ask: 'City', path: 'garaging.city', name: 'Owner home city (NoHit)' },
      { q: '1B89', field: 'CurrentAddress.ZipCode', ask: 'Zip Code', path: 'garaging.zip', name: 'Owner home ZIP (NoHit)' },
      { q: '1B8B', field: 'NoHitCredit.DOB', ask: 'Date of Birth', name: 'Owner date of birth (NoHit)', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
      { q: '1B8D', field: 'NoHitCredit.SSN', ask: 'Social Security Number', name: 'Social Security Number (never filled; the agent enters one only if the client gave it)', ignore: true },
    ]),

    // --- More about the business (MoreAboutBusiness) -------------------------------------------
    ...onPage('MoreAboutBusiness', [
      { q: '77', field: 'AccountInput.Email', ask: 'Customer Email Address', name: 'Customer email (optional in this workflow)', ignore: true },
      { q: '81', field: 'MoreBusinessInput.HasCurrentInsurancePolicy', ask: 'Is the customer currently insured?', name: 'Currently insured', kind: 'bool', value: currentlyInsured },
      { q: '83', field: 'MoreBusinessInput.HasContinuousCoverage', ask: 'Has the customer had continuous coverage?', name: 'Continuous coverage (standard: Yes when insured)', kind: 'bool', value: currentlyInsured },
      { q: '95', field: 'MoreBusinessInput.CurrentLimitsBodilyInjuryCoverage', ask: 'Current Bodily Injury Liability Limit', path: 'priorInsurance[0].limit', kind: 'choice', ignore: (r) => !currentlyInsured(r) },
      { q: '9D', field: 'PriorInsurance.ExpirationDate', ask: 'Current Policy Expiration Date', path: 'priorInsurance[0].expiration', ignore: (r) => !currentlyInsured(r) },
      { q: 'A2', field: 'MoreBusinessInput.OtherBusinessCoverages', ask: 'Does the customer have other coverages for the business?', name: 'Other business coverages (standard: None)', kind: 'choice', value: () => 'None' },
      // Checkbox version of the same questions (IN): a coverage the intake doesn't mention is No,
      // so "None of the above" in both groups and the coverages themselves left unticked.
      { q: 'AA', field: 'MoreBusinessInputNonShredded.OtherBusinessCoveragesNoneInd', ask: 'None of the above', each: true, name: 'Other coverages: None of the above (coverage not on the intake = No)', kind: 'bool', value: () => true },
      { q: 'B2', field: 'MoreBusinessInputNonShredded.ProgressiveBundleNoneInd', ask: 'None of the above', each: true, name: 'Other coverages: None of the above (coverage not on the intake = No)', kind: 'bool', value: () => true },
      ...[['A7', 'Business Owners Policy'], ['A8', 'General Liability'], ['A9', 'Workers\' Compensation'], ['AF', 'Business Owners Policy'], ['B0', 'General Liability']]
        .map(([q, ask]) => ({ q, ask, each: true, name: 'Other coverage (not on the intake = No)', kind: 'bool', value: () => false })),
      { q: 'B7', field: 'MoreBusinessInput.AdditionalInsuredCount', ask: 'Number of Named Additional Insureds', name: 'Named additional insured count (preserve prefilled value)', ignore: true },
      { q: 'B8', field: 'MoreBusinessInput.WaiverOfSubrogationCount', ask: 'Number of Named Waiver of Subrogation Holders', name: 'Named waiver count (preserve prefilled value)', ignore: true },
      { q: 'BE', field: 'AccountInput.BlanketAIQuestion', ask: 'Is a Blanket Additional Insured endorsement needed by contract?', name: 'Blanket additional insured (preserve prefilled value)', ignore: true },
      { q: 'C1', field: 'AccountInput.BlanketWOSQuestion', ask: 'Is a Blanket Waiver of Subrogation endorsement needed by contract?', name: 'Blanket waiver of subrogation (preserve prefilled value)', ignore: true },
      { q: 'CA', field: 'MoreBusinessInput.HasOperatingAuthority', ask: 'Are state or federal filings required?', name: 'Filings required', kind: 'bool', value: filings, note: filingsNote },
      { q: 'D1', field: 'PolicyInput.ELDHoursOfServiceRecords', ask: 'Is an Electronic Logging Device (ELD) required to record hours of service?', name: 'Electronic logging', kind: 'bool', value: usesEld, note: eldNote },
    ]),

    // --- Filings (pageName=Filings; only reached when filings are required) --------------------
    ...onPage('Filings', [
      { q: 'F11', field: 'FilingsInput.AllVehiclesUsedOwned', ask: 'Will this quote include all the customer\'s commercially owned and operated vehicles?', name: 'All commercially owned vehicles on this quote (standard: Yes)', kind: 'bool', value: filings },
      { field: 'FilingsInput.FederalOpAuthorityIndicator', label: '^federal( liability)?( filing)?$', name: 'Federal filing', kind: 'bool', value: filings },
      { field: 'FilingsInput.MCS90Indicator', label: '^mcs ?-?90$', name: 'MCS-90 (ticked by the page with Federal)', kind: 'bool', ignore: true },
      { field: 'FilingsInput.StateIndicator', label: '^state( filing)?$', name: 'State filing', kind: 'bool', ignore: true },
    ]),

    // --- Add vehicle (AddVehicle) ----------------------------------------------------------------
    ...onPage(['AddVehicle', 'MostCommonVehicles'], [
      { q: '2B00', ask: 'Add Vehicle By', name: 'Vehicle entry method (agent chooses VIN)', ignore: true },
      // Filled by the VIN lookup.
      { q: '2BB4', ask: 'What is the gross vehicle weight?', name: 'Gross vehicle weight (from VIN lookup)', ignore: true },
      { q: '2BCB', field: 'RiskInput.AnnualMileage', ask: 'Annual Mileage', name: 'Annual mileage (from VIN lookup)', ignore: true },
      // Safety equipment (FL): the VIN lookup answers these; Progressive's answers are kept, and only
      // a box the lookup leaves empty goes to the agent.
      ...[['2BA1', 'Anti-lock brakes', 'Anti-Lock Brakes?', 'RiskInput.AntiLockBrakes'], ['2BAC', 'Anti-theft device', 'Anti-Theft Device Discount', 'RiskInput.AntiTheftDevice'], ['2BAE', 'Driver-side airbag', 'Driver-Side Airbag?', 'RiskInput.Airbag']].map(([q, name, ask, field]) => ({
        q, field, ask, name: `${name} (from VIN lookup)`, ignore: true, emptyNote: `${name}: comes from the VIN lookup, which left it empty. Answer it yourself.`,
      })),
      { q: '2B20', field: 'RiskInput.VIN', ask: 'Vehicle Identification Number (VIN)', path: 'vehicles[].vin' },
      { q: '2B92', field: 'RiskInput.PrimaryZIP', ask: 'Zip code where the vehicle is located', path: 'garaging.zip' },
      // "Unlimited" / long haul becomes 501 miles, which picks "More than 500 miles".
      { q: '2B9D', field: 'RiskInput.Radius', ask: 'Farthest one-way distance this vehicle typically travels (90% or more of the time)', name: 'Farthest one-way distance', kind: 'int', value: radiusMiles },
      { q: '2C05', field: 'BCBTUVehQuestions.V01Use', ask: 'Is this vehicle used for business, personal or both?', name: 'Business / personal use', kind: 'choice', value: (r) => (r.operations.personalUse === false ? 'Business Only' : r.operations.personalUse ? 'Business & Personal' : null) },
      { q: '2C1A', field: 'BCBTUVehQuestions.V03GoodsHaulIndicator', ask: 'Is this vehicle used to haul goods on a For-Hire basis?', name: 'Hauls for hire', kind: 'bool', value: () => true },
      // Loan / lease: from the intake's vehicle ownership (also read from the claims-box notes);
      // owned or not stated is TNI's standard No.
      { q: '2CA7', field: 'RiskInput.OwnLeaseIndicator', ask: 'Is there a loan/lease on this vehicle?', name: 'Loan / lease (from ownership, standard: No)', kind: 'choice', value: loanLease },
      // NJ: who the vehicle is registered to.
      { q: '2C97', ask: 'Vehicle Registrant?', name: 'Vehicle registrant (standard: Named insured)', kind: 'choice', value: () => 'Named insured' },
      // NJ safety equipment boxes: the VIN lookup ticks what the vehicle has; left as Progressive set them.
      ...[['2C2C', 'Anti-Lock Brakes'], ['2C2D', 'Traction Control'], ['2C2E', 'Five MPH Bumpers'], ['2C45', 'Anti-Theft Device 1'], ['2C46', 'Anti-Theft Device 2'], ['2C47', 'Anti-Theft Device 3'], ['2C48', 'Anti-Theft Device 4']]
        .map(([q, ask]) => ({ q, ask, name: `${ask} (from VIN lookup)`, ignore: true })),
      { q: '2CCC', field: 'RiskInput.CompCollIndicator', ask: 'Does the customer need Comprehensive or Collision coverage to protect this vehicle in an accident or loss?', name: 'Comprehensive / collision (standard: Yes)', kind: 'bool', value: () => true },
      { q: '2CE0', ask: 'What is the value of the permanently attached equipment?', name: 'Attached equipment amount (only with more than $2,000)', ignore: true },
      // Asked here for the vehicle being added, and on Rates (FL, NC, OH) once per vehicle, where each
      // row gets its own vehicle's answer: the same fields, one rule each (scope: 'vehicle').
      { q: '2CCE', field: 'RiskInput.PAValueOptions', ask: 'What is the total value of all permanently attached equipment (including aftermarket parts, mounted equipment, and modifications)?', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment, scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '2CE3', field: 'RiskInput.PAValueIndicator', ask: 'Vehicle has no equipment', name: 'Vehicle has no equipment (standard)', kind: 'bool', value: () => true, scope: 'vehicle' },
      { q: '2CE8', field: 'RiskInput.NonPAValue', ask: 'If this vehicle was sold today, how much would it be worth (excluding any permanently attached equipment)?', path: 'vehicles[].value', name: 'Vehicle value if sold today', note: vehicleValueNote, scope: 'vehicle' },
    ]).map(offTrailerPages),
    // --- Add trailer (AddTrailer) ------------------------------------------------------------
    // The active trailer's answers (TNI 2026-10-07): the intake's VIN, year, make and value, the
    // vehicle's distance, loan/lease from the trailer ownership, comprehensive/collision Yes and
    // no equipment (or the intake's equipment value). No VIN lookup here. Found on this page only
    // (the names are the vehicle's).
    ...onPage('AddTrailer', [
      { q: '2A29', field: 'RiskInput.VIN', ask: 'VIN', path: 'trailers[].vin' },
      { q: '2A2A', field: 'RiskInput.Year', ask: 'Year', path: 'trailers[].year', kind: 'choice' },
      { q: '2A2B', field: 'RiskInput.MakeCode', ask: 'Make', path: 'trailers[].make', kind: 'choice' },
      { q: '2A61', field: 'RiskInput.PrimaryZIP', ask: 'Zip code where the vehicle is located', path: 'garaging.zip', name: 'Trailer ZIP' },
      { q: '2A65', field: 'RiskInput.Radius', ask: 'Farthest one-way distance this trailer travels for work', name: 'Trailer farthest one-way distance (as the vehicle)', kind: 'int', value: radiusMiles },
      { q: '2AD0', field: 'RiskInput.OwnLeaseIndicator', ask: 'Is there a loan/lease on this trailer?', name: 'Trailer loan / lease (from trailer ownership, standard: No)', kind: 'choice', value: trailerLoanLease, note: trailerOwnershipNote },
      { q: '2AEE', field: 'RiskInput.CompCollIndicator', ask: 'Does the customer need Comprehensive or Collision coverage to protect this trailer in an accident or loss?', name: 'Trailer comprehensive / collision (standard: Yes)', kind: 'bool', value: () => true },
      { q: '2AFF', field: 'RiskInput.PAValueIndicator', ask: 'Trailer has no equipment', name: 'Trailer has no equipment (standard, unless the intake gives an equipment value)', kind: 'bool', value: (r) => trailerEquipment(r) == null },
      { q: '2AFC', field: 'RiskInput.PAValue', ask: 'What is the value of the permanently attached equipment?', name: 'Trailer equipment value (from the intake)', kind: 'money', value: trailerEquipment, ignore: (r) => trailerEquipment(r) == null },
      { q: '2B04', field: 'RiskInput.NonPAValue', ask: 'If this trailer was sold today, how much would it be worth (excluding any permanently attached equipment)?', path: 'trailers[].value', name: 'Trailer value if sold today', note: trailerValueNote },
    ]).map((rule) => ({ ...rule, pageOnly: true })),

    // --- Add driver (AddDriver) ------------------------------------------------------------------
    ...onPage('AddDriver', [
      { q: '2898', field: 'DriverInput.FirstName', ask: 'Name', path: 'drivers[].first' },
      { q: '2899', field: 'DriverInput.DriverMiddleInitial', ask: 'MIMiddle initial', optional: true, name: 'Driver middle initial', value: (r, a) => r.drivers[a.drivers ?? 0]?.middle?.[0] ?? null, ignore: true },
      { q: '289A', field: 'DriverInput.LastName', ask: 'Driver Last Name', path: 'drivers[].last' },
      { q: '28A7', field: 'DriverInput.DateOfBirth', ask: 'Date of Birth', path: 'drivers[].dob' },
      { q: '28AC', field: 'DriverInput.LicenseStateDup', ask: 'Driver\'s License State', path: 'drivers[].licenseState' },
      { q: '28E6', field: 'DriverInput.HasCDL', ask: 'Does this driver have a Commercial Driver\'s License (CDL)?', path: 'drivers[].cdl', name: 'Has a CDL', kind: 'bool' },
      { q: '28B9', field: 'DriverInput.DriverLicenseNumber', ask: 'Driver’s License Number', path: 'drivers[].licenseNumber' },
      // OK (2026-10-07): a defensive driving course discount. TNI's standard: No; the agent changes it
      // when the client has taken one. (299D: the id when it was first seen, after the renumbering.)
      { q: '299D', field: 'DriverInput.DefensiveDriverDiscount', ask: 'Defensive Driver Discount', name: 'Defensive driver discount (standard: No)', kind: 'bool', value: () => false },
      { q: '28C1', field: 'DriverInput.DriverExcludedInd', ask: 'Exclude this driver from the policy?', name: 'Exclude driver (standard: No)', kind: 'bool', value: () => false },
      { q: '28F5', field: 'DriverInput.AnyAccidentsViolationsPastExpYears', label: '^has this driver had any accidents claims or violations in the past', path: 'claims.hasClaims', name: 'Accidents / claims / violations (3 yrs)', kind: 'bool' },
    ]),

    // --- Coverages and rates (CoveragesRates) ----------------------------------------------------
    ...onPage('CoveragesRates', [
      // The same answer shown again on Rates (NJ), with its own wording: Progressive carries it over.
      // Left as Progressive set it, but a carryover that didn't happen (empty) goes to the agent.
      { q: '2007', field: 'LoanLeaseInput.Limit', ask: 'Loan/Lease', name: 'Loan / lease on Rates (carried over from Add Vehicle)', ignore: true, emptyNote: 'Loan / lease should carry over from Add Vehicle but is empty here: answer it yourself.', scope: 'vehicle' },
      { q: '1D97', field: 'LineInput.RBIPDLimit', ask: 'Bodily Injury and Property Damage Liability', path: 'coverage.autoLiabLimit' },
      // FL: the CSL already covers property damage; PIP is required, $10k with no deductible (TNI).
      // Changing PIP makes Progressive invalidate the liability limit, which is picked again.
      { q: '1DB8', ask: 'Property Damage Liability Only', name: 'Property damage liability only (standard: Not Selected)', kind: 'choice', value: () => 'Not Selected' },
      // PIP shares its data-model name across states: other states' lists (TX $2,500–$25,000, MD
      // "Full PIP") are left as Progressive set them (TNI 2026-10-07: no standard there).
      { q: '1E8D', field: 'LineInput.PIPLimit', ask: 'Personal Injury Protection', name: 'Personal injury protection (FL standard: $10k w/ $0 Deductible; other states: as Progressive set it)', kind: 'choice', value: (r) => (isFlorida(r) ? '$10k w/ $0 Deductible' : null), ignore: (r) => !isFlorida(r) },
      { q: '1DEE', field: 'LineInput.UMUIMBILimit', ask: ['Uninsured/Underinsured Motorist Bodily Injury', 'Uninsured/Underinsured Motorist Bodily Injury Coverage Limit', 'Uninsured Motorist Bodily Injury coverage limit'], name: 'Uninsured / underinsured motorist liability', kind: 'choice', value: () => '$100k CSL', scope: 'policy' },
      // States that ask UM and UIM separately (PA 1DCA/1DDE, IN 1DD8): the same $100k CSL.
      ...[['1DCA', { ask: 'Uninsured Motorist Bodily Injury' }], ['1DDE', { ask: 'Underinsured Motorist Bodily Injury' }], ['1DD8', { field: 'LineInput.UIMBILimit' }], ['1DBF', { field: 'LineInput.UMBILimit' }]]
        .map(([q, which]) => ({ q, ...which, name: 'Uninsured / underinsured motorist (standard: $100k CSL)', kind: 'choice', value: () => '$100k CSL' })),
      // Pennsylvania first-party benefits: not on the intake means not bought, except medical
      // expense, which PA requires (its lowest, $5,000).
      { q: '1E66', ask: 'Medical Expense Benefits', name: 'PA medical expense benefits (required: lowest, $5,000)', kind: 'choice', value: () => '$5,000' },
      ...[['1E69', 'Extraordinary Medical Expense'], ['1E6E', 'Income Loss'], ['1E71', 'Funeral Expense'], ['1E74', 'Accidental Death']]
        .map(([q, what]) => ({ q, ask: `${what} Benefits`, name: `PA ${what.toLowerCase()} benefits (not on the intake: Not Selected)`, kind: 'choice', value: () => 'Not Selected' })),
      // PIP's state choice (MD): its box has no question text and its fieldref isn't recorded yet; it's
      // the list offering "$2,500 Full PIP". Other states' (TX: plain amounts) stay the agent's.
      { q: '1E7C', withOption: '$2,500 Full PIP', name: 'PIP (preserve prefilled state choice)', ignore: true },
      { q: '1FCD', field: 'ComprehensiveInput.Deductible', name: 'Comprehensive deductible (standard: $1,000)', kind: 'choice', value: (r) => vehicleDeductible(r, 'comprehensiveDeductible'), scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '1FD2', field: 'CollisionInput.Deductible', name: 'Collision deductible (standard: $1,000)', kind: 'choice', value: (r) => vehicleDeductible(r, 'collisionDeductible'), scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '1FF2', field: 'RentalInput.Limit', name: 'Rental reimbursement (standard: $40/day, $1,200 max)', kind: 'choice', value: () => '$40 per day, $1,200 max', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      // Offered for a truck tractor next to Rental reimbursement (FL, 2026-10-05). TNI: Not selected.
      { q: '1FF9', field: 'RentalWithDTInput.Limit', name: 'Rental with downtime (TNI: Not selected)', kind: 'choice', value: () => 'Not selected', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '2000', field: 'RoadsideInput.Limit', name: 'Roadside / towing (first selected option)', kind: 'selected-option', value: () => 'Selected', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '200F', field: 'FireAndTheftInput.Deductible', name: 'Additional fire / theft coverage (standard: Not selected)', kind: 'choice', value: () => 'Not selected', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '1FDD', ask: 'UMPDInput.Limit', name: 'UMPD limit (standard: Not selected)', kind: 'choice', value: () => 'Not selected' },
      // Per-vehicle medical payments ("$… per person"; the column is labelled with the vehicle).
      { q: '1FE4', field: 'MedicalPaymentInput.Limit', name: 'Medical payments per person (standard: $5,000)', kind: 'choice', value: () => '$5,000 per person', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
      { q: '2158', cargo: 'section', ask: 'Does the customer require cargo coverage for mobile/modular homes and buildings?', name: 'Cargo for mobile/modular homes (standard: No)', kind: 'bool', value: () => false },
      { q: '215A', cargo: 'section', ask: 'Does the customer require cargo coverage for business documents or non-negotiable securities?', name: 'Cargo for business documents (standard: No)', kind: 'bool', value: () => false },
      // TNI: an unselected Reefer option on the intake means this coverage is not requested.
      { q: '215C', cargo: true, ask: 'Does the customer require Refrigeration Breakdown coverage?', path: 'coverage.reeferBreakdown', kind: 'bool', value: (r) => r.coverage.reeferBreakdown === true },
      { q: '216A', cargo: 'section', field: 'MTCargoCommodityCategories.MTCargolistOfCommodityCategories', name: 'Cargo commodity category', kind: 'choice', value: (r) => commodity(r)?.category ?? null },
      { q: '216B', cargo: 'section', field: 'MTCargoCommodityCategories.MTCargoListOfCommodities', name: 'Cargo commodity', kind: 'choice', value: (r) => commodity(r)?.commodity ?? null },
      // The cargo row's limit (its data-model name), then the cargo section's, which reads the same:
      // with the row's taken, "Motor Trucking Cargo" is left with one field, the section's.
      { q: '2150', cargo: 'limit', field: 'LineInput.MotorTruckingCargoLimit', ask: 'Motor Trucking Cargo', name: 'Motor truck cargo summary', kind: 'choice', value: cargo, note: cargoNote },
      { q: '216F', cargo: 'limit', ask: 'Motor Trucking Cargo', name: 'Motor truck cargo', kind: 'choice', value: cargo, note: cargoNote },
      // No live Progressive GL question IDs have been validated. Keep any requested GL visible to
      // the agent for review instead of allowing generic label matching to make an assertion.
      { name: 'General Liability (manual review)', label: '^general liability', ignore: (r) => r.coverage.gl !== true, note: glNote },
    ]),
    // Trailer rows on Rates ("2019 Wilson", TNI 2026-10-07): comprehensive and collision $1,000,
    // rental and fire / theft not selected, no equipment and the trailer's value as on Add Trailer.
    // They carry the vehicle rows' data-model names: each row is found by its trailer's year, make
    // and model, on this page only.
    ...onPage('CoveragesRates', [
      { q: 'TR1FCD', field: 'ComprehensiveInput.Deductible', name: 'Trailer comprehensive deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000 Deductible' },
      { q: 'TR1FD2', field: 'CollisionInput.Deductible', name: 'Trailer collision deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000 Deductible' },
      { q: 'TR1FF2', field: 'RentalInput.Limit', name: 'Trailer rental reimbursement (standard: Not selected)', kind: 'choice', value: () => 'Not selected' },
      { q: 'TR200F', field: 'FireAndTheftInput.Deductible', name: 'Trailer fire / theft (standard: Not selected)', kind: 'choice', value: () => 'Not selected' },
      { q: 'TR2CE3', field: 'RiskInput.PAValueIndicator', ask: 'Trailer has no equipment', name: 'Trailer has no equipment (standard, unless the intake gives an equipment value)', kind: 'bool', value: (r) => trailerEquipment(r) == null },
      { q: 'TR2CE8', field: 'RiskInput.NonPAValue', ask: 'If this trailer was sold today, how much would it be worth (excluding any permanently attached equipment)?', path: 'trailers[].value', name: 'Trailer value if sold today', note: trailerValueNote },
    ]).map((rule) => ({ ...rule, scope: 'trailer', pageOnly: true })),

    // --- Bill plan options (ChangePaymentPlan) ---------------------------------------------------
    ...onPage('ChangePaymentPlan', [
      { q: '3E96', field: 'ChangePaymentPlanPage.PolicyTerm', ask: 'Policy length', name: 'Policy length (preserve prefilled value)', ignore: true },
      { q: '3E97', field: 'ChangePaymentPlanPage.PaymentType', ask: 'How will the customer pay?', name: 'Installment plan (preserve prefilled value)', ignore: true },
      { q: '3E98', field: 'BillingInfoInput.BillPlanEFTInd', ask: 'Payment method', name: 'Payment method (standard: automatic payments from checking account)', kind: 'choice', value: () => 'Automatic payments from checking account' },
      { q: '3EA4', field: 'BillingInfoInput.TwelveMonthBillPlanOnUI', name: 'Payment schedule detail (preserve prefilled value)', ignore: true },
    ]),

    // --- Print (PrintEmailFax) ---------------------------------------------------------------
    ...onPage('PrintEmailFax', [
      { q: '32B0', withOption: 'Insurance Quote (with all bill plans)', name: 'Documents (standard: insurance quote)', kind: 'choice', value: () => 'Insurance Quote (with all bill plans)' },
      { q: '32C8', ask: 'Welcome Letter Closing Message', name: 'Welcome letter closing message (optional)', ignore: true },
      { q: '32CC', ask: 'Print', name: 'Print (standard)', kind: 'bool', value: () => true },
      { q: '32CE', ask: 'Agent Fax Cover Page', name: 'Agent Fax Cover Page (preserve portal selection)', ignore: true },
      { q: '32D0', ask: 'Email', name: 'Email (leave unchecked)', ignore: true },
      { q: '32DD', ask: 'Fax', name: 'Fax (leave unchecked)', ignore: true },
    ]),

    // --- Save Quote (SaveQuote) ------------------------------------------------------------------
    // The agent saves the quote for the client: its contact boxes are theirs.
    ...onPage('SaveQuote', [
      { q: '2D42', ask: 'Business Name', name: 'Save Quote contact details (the agent\'s)', ignore: true },
      { q: '2D4C', ask: 'Primary Phone Number', name: 'Save Quote contact details (the agent\'s)', ignore: true },
      // The phone's other two boxes have no question text: they're named after the phone check on them.
      { q: '2D4E', label: 'invalid phone number', each: true, name: 'Save Quote contact details (the agent\'s)', ignore: true },
      { q: '2D50', label: 'invalid phone number', each: true, name: 'Save Quote contact details (the agent\'s)', ignore: true },
      { q: '2D55', ask: 'Customer Email Address', name: 'Save Quote contact details (the agent\'s)', ignore: true },
    ]),

    // --- Finish & buy (AdditionalDetails) --------------------------------------------------------
    ...onPage('AdditionalDetails', [
      { q: '396', label: 'agent of record', name: 'Agent of Record (preserve prefilled value)', ignore: true },
      { q: '3E3', label: 'employer identification', name: 'Employer Identification Number (finish flow; agent review)', ignore: true },
      { q: '450', label: '\\b(mvr|clue)\\b', name: 'Order MVR/CLUE reports', note: 'Agent decision — not filled' },
    ]),
  ],
};
