// Progressive commercial auto, ForAgentsOnly (clpolicy.foragentsonly.com).
//
// The quote flow is an ExtJS 6 + Duck Creek ("DCT") single-page app. Every field is keyed by a
// Duck Creek question id (`q`), taken from the element id / field name; `label` is a fallback
// regex on the question text in case Progressive renumbers. Mapped from live MD for-hire
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
  const last = full.split(/\s+/).at(-1)?.toLowerCase();
  const nameKey = (name) => (String(name ?? '').toLowerCase().match(/\p{L}+/gu) ?? []).sort().join(' ');
  const fullMatches = r.drivers.filter((d) => nameKey(full) && nameKey(`${d.first ?? ''} ${d.middle ?? ''} ${d.last ?? ''}`) === nameKey(full));
  const lastMatches = r.drivers.filter((d) => last && d.last?.toLowerCase() === last);
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
  return !!(p && /commercial\s+auto/i.test(p.type ?? '') && /progressive/i.test(p.carrier ?? '') && p.limit && p.expiration);
};

// After a USDOT lookup Progressive offers the registered business name / address as a choice,
// next to "Enter a different …". Agents pick the registered one. Without a USDOT number there is
// no such choice: the manual boxes are the only option and get the intake's values (below and
// in the reviewed address rules).
const registered = (prefer) => ({ kind: 'pick-not', value: () => ({ not: '^enter a different', prefer }), ignore: (r) => !r.applicant.dot });

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
const currentlyInsured = (r) => !!r.priorInsurance?.some((p) => p.limit && p.expiration);
// Once For Hire Trucking reveals this question, the agency workflow uses this subtype.
const truckerType = (r) => (isExpediter(r) ? 'Other For-Hire Trucking' : null);
// LLC / Inc / Corp in the name means a corporation; the owner-operators quoted so far without
// one were sole proprietors. Partnerships are never guessed.
const businessStructure = (r) => (/\b(llc|l\.l\.c|inc|corp|corporation|company|co)\.?$/i.test(r.applicant.name ?? '')
  ? 'Corporation or LLC / Non-Profit' : 'Individual / Sole Proprietor');

// The whole address on one line, for address boxes that offer the carrier's own suggestions.
const oneLineAddress = (r) => {
  const g = r.garaging ?? {};
  if (!g.street) return null;
  return [[g.street, g.unit].filter(Boolean).join(' '), g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
};

const PRINT_EMAIL_FAX = '^print(,? ?[/,]? ?e-?mail)?(,? ?[/,]? ?(and |or )?fax)?$';

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
  { path: 'vehicles[].year', label: '^(vehicle |model |truck )?year$', not: 'trailer', verifyOnly: true },
  { path: 'vehicles[].make', label: '^(vehicle |truck )?make$', not: 'trailer', verifyOnly: true },
  { path: 'vehicles[].model', label: '^(vehicle |truck )?model$', not: 'trailer|year', verifyOnly: true },
  { path: 'vehicles[].vin', label: '\\bvin\\b|vehicle identification', not: 'trailer' },
  { path: 'vehicles[].value', label: 'stated (value|amount)|(vehicle|truck|unit) value|actual cash value|cost new|^value$', not: 'trailer|cargo|equipment' },
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

// Vehicle picker tile for the intake's vehicle type.
const VEHICLE_TILES = { Van: 'Cargo Van' };
const vehicleTile = (r, a) => {
  const type = r.vehicles[a.vehicles ?? 0]?.type;
  return type ? `^${(VEHICLE_TILES[type] ?? type).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : null;
};

export const progressive = {
  id: 'progressive',
  name: 'Progressive',
  hosts: [/(^|\.)foragentsonly\.com$/, /(^|\.)progressive\.com$/],
  // ExtJS components are only reachable from the page's own JavaScript world.
  world: 'MAIN',
  // Only the quote flow is filled automatically (not the home or quote-search pages).
  autoFillUrl: /\/Express\/Default\.aspx/i,
  // Live Progressive question ids are mapped explicitly below. Generic label fallbacks can
  // turn an unvalidated field (especially optional contact or GL fields) into an assertion.
  useGenericRules: false,
  // Never flagged as "needs you" when empty: the agent fills these only when they apply.
  optional: ['296', '298', '233', '1CC', '2899', '1B80', '1B82'],
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
    { id: 'vehicleTile', page: 'MostCommonVehicles', text: vehicleTile, scope: 'vehicle' },
    { id: 'lookupVin', page: 'AddVehicle', text: '^look ?up( vin)?$', after: ['vehicles[].vin'], immediate: true, scope: 'vehicle' },
    // The "+" in the Motor Truck Cargo row (every coverage has one).
    { id: 'openCargo', page: 'CoveragesRates', text: '^\\+$', near: 'motor truck cargo', unless: ['progressive.q2150', 'progressive.q216F'], when: (r) => r.coverage.cargo === true },
    { id: 'addCargoCommodity', page: 'CoveragesRates', text: '^add( another)?( a)? commodity$', afterActions: ['openCargo'], when: (r) => r.coverage.cargo === true },
    { id: 'doneCargo', page: 'CoveragesRates', text: '^done with this coverage$', afterActions: ['addCargoCommodity'], after: ['progressive.q216A', 'progressive.q216B'], afterAny: ['progressive.q216F', 'progressive.q2150'], verify: 'cargoClosed', when: (r) => r.coverage.cargo === true },
    // Rates, as TNI agents work it: once cargo is added (and no GL is requested), open the bill
    // plan options, pick automatic payments there, come back (Continue), then Recalculate, then
    // Print, Email, Fax. With GL requested the agent does the rates page by hand.
    { id: 'billPlan', page: 'CoveragesRates', text: '^(view )?bill(ing)?( plan)? options?$', afterActions: (r) => r.coverage.cargo ? ['doneCargo'] : [], afterAny: ['coverage.autoLiabLimit', 'progressive.q2150', 'progressive.q216F'], when: (r) => r.coverage.gl !== true },
    // Back from the bill plan Progressive has usually recalculated already (Recalculate is gone,
    // Print, Email, Fax is there): Recalculate only when the rates say they're out of date.
    { id: 'recalculate', page: 'CoveragesRates', text: '^recalculate$', after: ['coverage.autoLiabLimit'], afterPages: ['ChangePaymentPlan'], needsRecalculation: true, verify: 'premium' },
    // Progressive shows Print, Email, Fax (in place of Recalculate) only once the rates are
    // current, so back from the bill plan the button itself is the signal.
    { id: 'print', page: 'CoveragesRates', text: PRINT_EMAIL_FAX, afterPages: ['ChangePaymentPlan'] },
    // This page may have been opened by the agent or restored after a panel reload. Its own
    // document and delivery controls establish readiness; no in-memory navigation history is needed.
    { id: 'printSend', page: 'PrintEmailFax', text: '^print ?/ ?send$', after: ['progressive.q32B0', 'progressive.q32CC'], verify: 'download' },
  ],
  // The page listing the quote's vehicles: the side panel works on the next intake vehicle not
  // added yet there, so Add Vehicle repeats until all are in, then Continue.
  vehicleList: 'VehicleSummary',
  // Same for drivers: the AddDriver page marks its driver entered once filled.
  driverList: 'DriverSummary',
  driverPage: 'AddDriver',
  // Pages that need the agent whatever the intake says; the side panel says so at the top.
  agentPages: {
    NoHit: "Progressive couldn't verify the business owner. Check the owner's name, date of birth and home address with the client (and enter the SSN if they gave it), then Continue.",
  },
  // When a page has nothing left for the agent, its Continue ("Ok, start quote." on page 1) is
  // clicked. Never on the finish/buy pages.
  advance: { text: '^(continue|ok,? start quote\\.?)\\W*$', exceptPages: ['AdditionalDetails', 'SaveQuote', 'Quote', 'PrintEmailFaxConfirm'] },
  rules: [
    ...SAFE_LABEL_RULES,
    // --- Named Insured and Business Overview (pageName=BusinessOwnerInfo) ---------------------
    { q: '18F', name: 'Agent code (preserve prefilled value)', ignore: true },
    { q: '194', name: 'Policy start date (preserve prefilled value)', ignore: true },
    { q: '198', name: 'Currently insured with Progressive Commercial Auto', kind: 'bool', value: insuredWithProgressive },
    { q: '1CC', name: 'Quote vendor code (optional)', ignore: true },
    { q: '1ED', name: 'Has a USDOT number', kind: 'choice', value: (r) => {
      if (r.applicant.dot) return 'Yes - the customer has a USDOT number';
      if (r.applicant.mcDotWithin60Days === true) return 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days';
      return 'No - and the customer will not have a USDOT number';
    } },
    { q: '1F3', path: 'applicant.dot', label: 'usdot number', ignore: (r) => !r.applicant.dot },
    { q: '20F', name: 'USDOT number belongs to the business (standard: Yes)', kind: 'bool', ignore: (r) => !r.applicant.dot, value: (r) => (r.applicant.dot ? true : null) },
    { q: '22F', name: 'Business name (USDOT record)', ...registered() },
    { q: '277', name: 'Primary business address (USDOT record)', ...registered() },
    // Always the first choice offered. When that's "Enter a different address", the address box
    // below gets the whole address and Progressive's first suggestion.
    { q: '2A5', name: 'Owner home address (first option)', kind: 'first-option', value: () => 'first option' },
    { q: '230', path: 'applicant.name', name: 'Business / sole proprietor name', value: (r) => r.applicant.name || r.applicant.owner1, ignore: (r) => !!r.applicant.dot },
    { q: '233', name: 'DBA name (always left empty)', ignore: true },
    // Owner home address box, shown when there's no registered address to pick ("2AA" after
    // "Enter a different address", "2A9" when there's no choice at all): the whole address,
    // then Progressive's first suggestion, which fills ZIP and city. The ZIP/city rules then
    // check what it filled against the intake.
    { q: '2AA', name: 'Owner home address (with suggestion)', kind: 'address-suggest', value: oneLineAddress },
    { q: '2A9', name: 'Owner home address (with suggestion)', kind: 'address-suggest', value: oneLineAddress },
    { q: '2AE', path: 'garaging.zip', name: 'Owner home ZIP' },
    { q: '2B0', path: 'garaging.city', name: 'Owner home city' },
    // Business address boxes, when there's no registered address to pick.
    // Business street with Google's address suggestions, like the home address box: the whole
    // address, then the first suggestion, which fills ZIP and city (checked by their rules).
    { q: '27E', name: 'Business address (with suggestion)', kind: 'address-suggest', value: oneLineAddress, fallback: (r) => r.garaging?.street ?? null },
    { q: '284', path: 'garaging.zip', name: 'Business ZIP' },
    { q: '286', path: 'garaging.city', name: 'Business city' },
    // Search-style business type (IN, OH): the box itself is left alone (typing filters the list
    // away); the result list (BECAPopup q36) gets For Hire Trucking, or General Freight Trucking
    // when the list doesn't have it. Options read "<name> <description>".
    { q: '24D', name: 'Business type box (filled by the search)', ignore: true },
    { q: '1D', name: 'Business type search box', ignore: true },
    { q: '36', name: 'Business type (search list: For Hire Trucking, else General Freight Trucking)', kind: 'choice', value: () => 'For Hire Trucking', choiceAliases: () => ['General Freight Trucking'] },
    { q: '239', name: 'Business type', kind: 'choice', label: '^business type(?: list)?$', value: businessType, choiceAliases: businessAliases, summaryAfter: (r) => isExpediter(r) ? '267' : '22D' },
    { q: '22D', name: 'Business structure', kind: 'choice', label: 'business structured', value: businessStructure },
    { q: '267', name: 'Type of trucker', kind: 'choice', label: 'type of trucker', value: truckerType, ignore: (r) => !isExpediter(r) },
    { q: '295', name: 'Owner first name', label: '^first name$', value: (r) => owner(r).first },
    { q: '296', name: 'Owner middle initial', value: (r) => owner(r).middle?.[0] ?? null, ignore: true },
    { q: '297', name: 'Owner last name', label: '^last name$', value: (r) => owner(r).last },
    { q: '298', name: 'Owner suffix (optional)', ignore: true },
    { q: '29F', name: 'Owner is a driver', kind: 'bool', path: 'applicant.ownerDrives' },
    { q: '2BB', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    // The demonstrated workflow deliberately leaves Progressive's optional phone boxes blank.
    { q: '2DB', name: 'Phone area code (optional)', ignore: true },
    { q: '2DD', name: 'Phone prefix (optional)', ignore: true },
    { q: '2DF', name: 'Phone line number (optional)', ignore: true },
    { q: '2F6', path: 'operations.hazPlacard', name: 'Hazmat placard required', label: 'hazardous material placard' },

    // --- Owner not found by Progressive's lookup (NoHit) ----------------------------------------
    // The owner's details again, for a second search. The SSN is never filled.
    { q: '1B7F', name: 'Owner first name (NoHit)', value: (r) => owner(r).first },
    { q: '1B80', name: 'Owner middle initial (NoHit, optional)', ignore: true },
    { q: '1B81', name: 'Owner last name (NoHit)', value: (r) => owner(r).last },
    { q: '1B82', name: 'Owner suffix (NoHit, optional)', ignore: true },
    { q: '1B84', name: 'Owner home address (NoHit)', value: (r) => [r.garaging?.street, r.garaging?.unit].filter(Boolean).join(' ') || null },
    { q: '1B85', path: 'garaging.city', name: 'Owner home city (NoHit)' },
    { q: '1B89', path: 'garaging.zip', name: 'Owner home ZIP (NoHit)' },
    { q: '1B8B', name: 'Owner date of birth (NoHit)', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    { q: '1B8D', name: 'Social Security Number', note: 'Social Security Number: the agent enters it or leaves it; never filled.' },

    // --- More about the business (MoreAboutBusiness) -------------------------------------------
    { q: '77', name: 'Customer email (optional in this workflow)', ignore: true },
    { q: '81', name: 'Currently insured', kind: 'bool', label: '^is the customer currently insured$', value: currentlyInsured },
    { q: '83', name: 'Continuous coverage (standard: Yes when insured)', kind: 'bool', label: 'continuous coverage', value: currentlyInsured },
    { q: '95', path: 'priorInsurance[0].limit', kind: 'choice', label: 'current bodily injury', ignore: (r) => !currentlyInsured(r) },
    { q: '9D', path: 'priorInsurance[0].expiration', label: 'current policy expiration', ignore: (r) => !currentlyInsured(r) },
    { q: 'A2', name: 'Other business coverages (standard: None)', kind: 'choice', label: 'other coverages for the business', value: () => 'None' },
    // Checkbox version of the same questions (IN): a coverage the intake doesn't mention is No,
    // so "None of the above" in both groups and the coverages themselves left unticked.
    { q: 'AA', name: 'Other coverages: None of the above (coverage not on the intake = No)', kind: 'bool', value: () => true },
    { q: 'B2', name: 'Other coverages: None of the above (coverage not on the intake = No)', kind: 'bool', value: () => true },
    ...['A7', 'A8', 'A9', 'AF', 'B0'].map((q) => ({ q, name: 'Other coverage (not on the intake = No)', kind: 'bool', value: () => false })),
    { q: 'B7', name: 'Named additional insured count (preserve prefilled value)', ignore: true },
    { q: 'B8', name: 'Named waiver count (preserve prefilled value)', ignore: true },
    { q: 'BE', name: 'Blanket additional insured (preserve prefilled value)', ignore: true },
    { q: 'C1', name: 'Blanket waiver of subrogation (preserve prefilled value)', ignore: true },
    { q: 'CA', name: 'Filings required', kind: 'bool', label: 'filings required', value: filings, note: filingsNote },
    { q: 'D1', name: 'Electronic logging', kind: 'bool', label: 'electronic logging', value: usesEld, note: eldNote },

    // --- Filings (pageName=Filings; only reached when filings are required) --------------------
    { q: 'F11', name: 'All commercially owned vehicles on this quote (standard: Yes)', kind: 'bool', label: 'all the customers commercially owned', value: filings },
    { label: '^federal( liability)?( filing)?$', name: 'Federal filing', kind: 'bool', value: filings },
    { label: '^mcs ?-?90$', name: 'MCS-90 (ticked by the page with Federal)', kind: 'bool', ignore: true },
    { label: '^state( filing)?$', name: 'State filing', kind: 'bool', ignore: true },

    // --- Add vehicle (AddVehicle) ----------------------------------------------------------------
    { q: '2B00', name: 'Vehicle entry method (agent chooses VIN)', ignore: true },
    // Filled by the VIN lookup.
    { q: '2BB4', name: 'Gross vehicle weight (from VIN lookup)', ignore: true },
    { q: '2BCB', name: 'Annual mileage (from VIN lookup)', ignore: true },
    { q: '2B20', path: 'vehicles[].vin' },
    { q: '2B92', path: 'garaging.zip', label: 'zip code where the vehicle' },
    // "Unlimited" / long haul becomes 501 miles, which picks "More than 500 miles".
    { q: '2B9D', name: 'Farthest one-way distance', kind: 'int', label: 'farthest one way distance', value: (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null) },
    { q: '2C05', name: 'Business / personal use', kind: 'choice', label: 'used for business personal', value: (r) => (r.operations.personalUse === false ? 'Business Only' : r.operations.personalUse ? 'Business & Personal' : null) },
    { q: '2C1A', name: 'Hauls for hire', kind: 'bool', label: 'for hire basis', value: () => true },
    // Loan / lease: from the intake's vehicle ownership (also read from the claims-box notes);
    // owned or not stated is TNI's standard No.
    { q: '2CA7', name: 'Loan / lease (from ownership, standard: No)', kind: 'choice', label: 'loan lease', value: loanLease },
    { q: '2CCC', name: 'Comprehensive / collision (standard: Yes)', kind: 'bool', label: 'comprehensive or collision', value: () => true },
    { q: '2CE0', name: 'Attached equipment amount (only with more than $2,000)', ignore: true },
    { q: '2CCE', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment },
    { q: '2CE3', name: 'Vehicle has no equipment (standard)', kind: 'bool', label: 'vehicle has no equipment', value: () => true },
    { q: '2CE8', path: 'vehicles[].value', name: 'Vehicle value if sold today', label: 'sold today', note: vehicleValueNote },
    // Same two questions under the ids other states/products use (NC, OH).
    { q: '208A', name: 'Vehicle has no equipment (standard)', kind: 'bool', value: () => true },
    { q: '2091', path: 'vehicles[].value', name: 'Vehicle value if sold today', note: vehicleValueNote },

    // --- Add driver (AddDriver) ------------------------------------------------------------------
    { q: '2898', path: 'drivers[].first' },
    { q: '2899', name: 'Driver middle initial', value: (r, a) => r.drivers[a.drivers ?? 0]?.middle?.[0] ?? null, ignore: true },
    { q: '289A', path: 'drivers[].last' },
    { q: '28A7', path: 'drivers[].dob' },
    { q: '28AC', path: 'drivers[].licenseState', label: 'drivers license state' },
    { q: '28E6', path: 'drivers[].cdl', name: 'Has a CDL', kind: 'bool', label: 'commercial drivers? licen[cs]e' },
    { q: '28B9', path: 'drivers[].licenseNumber', label: 'drivers license number' },
    { q: '28C1', name: 'Exclude driver (standard: No)', kind: 'bool', label: 'exclude this driver', value: () => false },
    { q: '28F5', path: 'claims.hasClaims', name: 'Accidents / claims / violations (3 yrs)', kind: 'bool', label: 'accidents claims or violations' },

    // --- Coverages and rates (CoveragesRates) ----------------------------------------------------
    { q: '1D97', path: 'coverage.autoLiabLimit', label: 'bodily injury and property damage liability' },
    { q: '1DEE', name: 'Uninsured / underinsured motorist liability', kind: 'choice', value: () => '$100k CSL', scope: 'policy' },
    // States that ask UM and UIM separately (PA 1DCA/1DDE, IN 1DD8): the same $100k CSL.
    ...['1DCA', '1DDE', '1DD8', '1DBF'].map((q) => ({ q, name: 'Uninsured / underinsured motorist (standard: $100k CSL)', kind: 'choice', value: () => '$100k CSL' })),
    // Pennsylvania first-party benefits: not on the intake means not bought, except medical
    // expense, which PA requires (its lowest, $5,000).
    { q: '1E66', name: 'PA medical expense benefits (required: lowest, $5,000)', kind: 'choice', value: () => '$5,000' },
    ...[['1E69', 'extraordinary medical expense'], ['1E6E', 'income loss'], ['1E71', 'funeral expense'], ['1E74', 'accidental death']]
      .map(([q, what]) => ({ q, name: `PA ${what} benefits (not on the intake: Not Selected)`, kind: 'choice', value: () => 'Not Selected' })),
    { q: '1E7C', name: 'PIP (preserve prefilled state choice)', ignore: true },
    { q: '1FCD', name: 'Comprehensive deductible (standard: $1,000)', kind: 'choice', value: (r) => vehicleDeductible(r, 'comprehensiveDeductible'), scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '1FD2', name: 'Collision deductible (standard: $1,000)', kind: 'choice', value: (r) => vehicleDeductible(r, 'collisionDeductible'), scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '1FF2', name: 'Rental reimbursement (standard: $40/day, $1,200 max)', kind: 'choice', value: () => '$40 per day, $1,200 max', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '2000', name: 'Roadside / towing (first selected option)', kind: 'selected-option', value: () => 'Selected', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '200F', name: 'Additional fire / theft coverage (standard: Not selected)', kind: 'choice', value: () => 'Not selected', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '1FDD', name: 'UMPD limit (standard: Not selected)', kind: 'choice', label: 'umpd', value: () => 'Not selected' },
    // Per-vehicle medical payments ("$… per person"; the column is labelled with the vehicle).
    { q: '1FE4', name: 'Medical payments per person (standard: $5,000)', kind: 'choice', value: () => '$5,000 per person', scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '207F', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment, scope: 'vehicle', scopeIndex: (r, a) => a.vehicles ?? 0 },
    { q: '2158', name: 'Cargo for mobile/modular homes (standard: No)', kind: 'bool', label: 'mobile modular homes', value: () => false },
    { q: '215A', name: 'Cargo for business documents (standard: No)', kind: 'bool', label: 'business documents or non negotiable', value: () => false },
    { q: '216A', name: 'Cargo commodity category', kind: 'choice', value: (r) => commodity(r)?.category ?? null },
    { q: '216B', name: 'Cargo commodity', kind: 'choice', value: (r) => commodity(r)?.commodity ?? null },
    { q: '216F', name: 'Motor truck cargo', kind: 'choice', value: cargo, note: cargoNote },
    { q: '2150', name: 'Motor truck cargo summary', kind: 'choice', value: cargo, note: cargoNote },
    // No live Progressive GL question IDs have been validated. Keep any requested GL visible to
    // the agent for review instead of allowing generic label matching to make an assertion.
    { name: 'General Liability (manual review)', label: '^general liability', ignore: (r) => r.coverage.gl !== true, note: glNote },

    // --- Bill plan options (ChangePaymentPlan) ---------------------------------------------------
    { q: '3E96', name: 'Policy length (preserve prefilled value)', ignore: true },
    { q: '3E97', name: 'Installment plan (preserve prefilled value)', ignore: true },
    { q: '3E98', name: 'Payment method (standard: automatic payments from checking account)', kind: 'choice', label: 'payment method', value: () => 'Automatic payments from checking account' },
    { q: '3EA4', name: 'Payment schedule detail (preserve prefilled value)', ignore: true },

    // --- Print (PrintEmailFax) ---------------------------------------------------------------
    { q: '32B0', name: 'Documents (standard: insurance quote)', kind: 'choice', value: () => 'Insurance Quote (with all bill plans)' },
    { q: '32C8', name: 'Welcome letter closing message (optional)', ignore: true },
    { q: '32CC', name: 'Print (standard)', kind: 'bool', value: () => true },
    { q: '32CE', name: 'Agent Fax Cover Page (preserve portal selection)', ignore: true },
    { q: '32D0', name: 'Email (leave unchecked)', ignore: true },
    { q: '32DD', name: 'Fax (leave unchecked)', ignore: true },

    // --- Finish & buy (AdditionalDetails) --------------------------------------------------------
    { q: '396', name: 'Agent of Record (preserve prefilled value)', ignore: true },
    { q: '3E3', name: 'Employer Identification Number (finish flow; agent review)', ignore: true },
    { q: '450', name: 'Order MVR/CLUE reports', note: 'Agent decision — not filled' },
  ],
};
