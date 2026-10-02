import { toDate } from '../normalize.js';

// Progressive commercial auto, ForAgentsOnly (clpolicy.foragentsonly.com).
//
// The quote flow is an ExtJS 6 + Duck Creek ("DCT") single-page app. Every field is keyed by a
// Duck Creek question id (`q`), taken from the element id / field name; `label` is a fallback
// regex on the question text in case Progressive renumbers. Mapped from live MD for-hire
// expediter quotes (captures/progressive/). Questions that exist only in other states or for
// other products are skipped when they aren't on the page, while unfamiliar questions stop automatic filling for agent review.
//
// Rules either read a record path, or compute a value with `value(record, active)` when
// Progressive words the answer differently from the intake form. `note` rules are questions the
// agent must answer themselves; they're marked, never filled.
//
// Follow-up questions the intake doesn't cover use TNI's standard answers (the agent's own
// choices on live quotes). The agent changes them for the exceptions.

// The business owner, matched to their driver row (for date of birth and a clean name split).
function owner(r) {
  const full = r.applicant.owner1 ?? '';
  const normalizeName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const parts = full.split(/\s+/).filter(Boolean);
  const last = parts.at(-1)?.toLowerCase();
  const matching = r.drivers.filter((d) => last && d.last?.toLowerCase() === last);
  const exact = matching.find((d) => normalizeName([d.first, d.middle, d.last].filter(Boolean).join(' ')) === normalizeName(full));
  const driver = exact ?? (matching.length === 1 ? matching[0] : null);
  const first = driver?.first ?? (matching.length <= 1 ? parts.slice(0, -1).join(' ') : null);
  return { driver, first: first || null, middle: driver?.middle ?? null, last: driver?.last ?? full.split(/\s+/).at(-1) ?? null };
}

const ownerReview = (r) => {
  const full = r.applicant.owner1 ?? '';
  const last = full.split(/\s+/).filter(Boolean).at(-1)?.toLowerCase();
  if (!full) return 'Confirm the business owner’s name.';
  const matching = r.drivers.filter((d) => last && d.last?.toLowerCase() === last);
  if (matching.length > 1 && !owner(r).driver) return 'The owner name matches multiple drivers; choose the correct owner/driver manually.';
  return null;
};

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
// in the generic address rules).
const registered = (prefer) => ({ kind: 'pick-not', value: () => ({ not: '^enter a different', prefer }) });

// Always "$0 to $2,000" at TNI; the agent changes it for the rare exception.
const equipment = () => '$0 to $2,000';
const noEquipment = (r) => r.operations.equipVehicle == null ? null : Number(r.operations.equipVehicle) === 0;

const cargo = (r) => {
  const c = r.coverage;
  if (c.cargo === false) return 'Not selected';
  return c.cargoLimit && c.cargoDeductible ? `$${c.cargoLimit}/$${c.cargoDeductible}` : null;
};

// What the intake calls the freight -> Progressive's commodity category and commodity.
const COMMODITIES = [
  { match: /general\s*freight/i, category: 'Consumer Goods', commodity: 'Other Consumer Goods' },
];
const commodity = (r) => COMMODITIES.find((c) => c.match.test(r.operations.whatHaul ?? '')) ?? null;

// A USDOT number by itself is not evidence that the customer wants filings. The application
// must say filings are required too, and the filing text must identify Federal when we check the
// Federal box. State and MCS-90 are left for the portal/agent because the intake does not establish
// those selections.
const federalFiling = (r) => (
  r.operations.filingsRequired === true && r.applicant.dot && /\bfederal\b/i.test(r.operations.filingsWhich ?? '')
    ? true
    : null
);
const filingsReview = (r) => (
  r.operations.filingsRequired !== true
    ? null
    : !r.applicant.dot
      ? 'The intake says filings are required but has no USDOT number; confirm the filing requirement before continuing.'
      : !r.operations.filingsWhich
        ? 'The intake says filings are required but does not identify which filings; confirm them before continuing.'
        : null
);

const ownerIsDriver = (r) => r.applicant.ownerDrives;

// The preliminary quote starts with No. Ownership notes in the intake can be ambiguous and do not
// establish the portal's loan/lease choice; the agent can correct it after this page is filled.
const loanLease = () => 'No';

const expirationReview = (r) => {
  const date = toDate(r.priorInsurance[0]?.expiration);
  if (!date) return 'Confirm a valid current policy expiration date.';
  const [month, day, year] = date.split('/').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(year, month - 1, day) < today
    ? 'The intake policy is expired; confirm it instead of substituting a new date.' : null;
};

const multiVehicleReview = (r) => (
  (r.vehicles?.length ?? 0) > 1
    ? 'Progressive shows per-vehicle coverage columns; confirm this control belongs to the active VIN before answering.'
    : null
);

// Progressive's business type (and, for trucking, the type of trucker) for what the intake
// calls the business. Expediters are "For Hire Trucking" / "Other For-Hire Trucking".
const isExpediter = (r) => /expedit|^(?:generic|general)?\s*trucking$|(?:generic|general|for[-\s]+hire)\s+trucking/i.test(r.operations.businessClass ?? '');
const businessType = (r) => (isExpediter(r) ? 'For Hire Trucking' : r.operations.businessClass);
const truckerType = (r) => (isExpediter(r) ? 'Other For-Hire Trucking' : r.operations.businessClass);

const PRINT_EMAIL_FAX = '^print(,? ?[/,]? ?e-?mail)?(,? ?[/,]? ?(and |or )?fax)?$';

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
  strictReview: true,
  reviews: [{ key: 'generalLiability', page: 'CoveragesRates', when: (r) => r.coverage.gl === true, note: 'GL was requested. Complete and review the General Liability questions and requested limit on the quote before continuing.' }],
  // Never flagged as "needs you" when empty: the agent fills these only when they apply.
  optional: [
    '18F', '194', '1CC', '233', '2899', '296', '298', '2A9', '2DB', '2DD', '2DF',
    '2CE0', 'B7', 'B8', 'BE', 'C1', '3E96', '3E97', '3EA4', '32C8', '396',
  ],
  // Progressive pre-selects some answers (filings No, $750k CSL, manual payments, rental "Not
  // selected"). Those are replaced when ours differ; anything the agent changed is left alone.
  replaceChoices: true,
  // Buttons the filler clicks, in order, each once per quote, only on its page and only once
  // `after` (any of these fields) has a value. `unless`: skip when any of these has a value.
  // `text` is a regex on the button's text, `token` a string in its id/href/onclick.
  // Never clicked, whatever a rule says: Continue, Next, Finish, Buy, Bind, Submit, Save.
  actions: [
    { id: 'verifyDot', page: 'BusinessOwnerInfo', text: '^verify( us)?( ?dot)?( number)?$', after: ['applicant.dot'], immediate: true },
    { id: 'vehicleTile', page: 'MostCommonVehicles', text: vehicleTile, perRecord: 'vehicles' },
    { id: 'lookupVin', page: 'AddVehicle', text: '^look ?up( vin)?$', after: ['vehicles[].vin'], immediate: true, perRecord: 'vehicles' },
    { id: 'openCargo', page: 'CoveragesRates', text: '^\\+$', near: 'motor truck cargo', unless: ['progressive.q216F'], when: (r) => r.coverage.cargo === true },
    { id: 'addCommodity', page: 'CoveragesRates', text: '^add (a |another )?commodity$', token: 'actionClick_AddAnotherCommodity', afterAll: ['progressive.q2158', 'progressive.q215A'], unless: ['progressive.q216B'], when: (r) => r.coverage.cargo === true },
    { id: 'doneCargo', page: 'CoveragesRates', text: '^done with this coverage$', afterAll: ['progressive.q2158', 'progressive.q215A', 'progressive.q216A', 'progressive.q216B', 'progressive.q216F'], when: (r) => r.coverage.cargo === true },
    { id: 'recalculate', page: 'CoveragesRates', text: '^recalculate( premium)?$', afterAll: ['coverage.autoLiabLimit'], afterActions: (r) => r.coverage.cargo === true ? ['doneCargo'] : [] },
    { id: 'billPlan', page: 'CoveragesRates', text: '^(view )?bill plan options?$', afterActions: ['recalculate'], readiness: 'premium', afterAll: ['coverage.autoLiabLimit'], after: (r) => r.coverage.cargo === true ? ['progressive.q2150', 'progressive.q216F'] : [] },
    // The agent continues from payment options back to Rates before document preparation.
    { id: 'print', page: 'CoveragesRates', text: PRINT_EMAIL_FAX, afterPages: ['ChangePaymentPlan'], afterActions: ['billPlan'], readiness: 'premium' },
    { id: 'printSend', page: 'PrintEmailFax', text: '^print ?/ ?send$', afterAll: ['progressive.q32B0', 'progressive.q32CC', 'progressive.q32D0', 'progressive.q32DD'], readiness: 'document' },
  ],
  rules: [
    // --- Named Insured and Business Overview (pageName=BusinessOwnerInfo) ---------------------
    { q: '18F', name: 'Agent code (preserve prefill)', ignore: true },
    { q: '194', name: 'Policy start date (preserve prefill)', ignore: true },
    { q: '1CC', name: 'Quote vendor code (preserve prefill)', ignore: true },
    { q: '198', name: 'Currently insured with Progressive Commercial Auto', kind: 'bool', value: insuredWithProgressive },
    { q: '1ED', name: 'Has a USDOT number', kind: 'choice', value: (r) => {
      if (r.applicant.dot) return 'Yes - the customer has a USDOT number';
      if (r.applicant.mcDotWithin60Days === true) return 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days';
      if (r.applicant.mcDotWithin60Days === false) return 'No - and the customer will not have a USDOT number';
      return null;
    } },
    { q: '1F3', path: 'applicant.dot', label: 'usdot number' },
    { q: '20F', name: 'Question after USDOT lookup (standard: Yes)', kind: 'bool', value: (r) => (r.applicant.dot ? true : null), review: (r) => (!r.applicant.dot ? 'Confirm whether the USDOT lookup belongs to this business.' : null) },
    { q: '22F', name: 'Business name (USDOT record)', ...registered() },
    { q: '277', name: 'Primary business address (USDOT record)', ...registered() },
    { q: '2A5', name: 'Owner home address', ...registered() },
    // Owner home address boxes, shown when there's no registered address to pick.
    { q: '2AA', path: 'garaging.street', name: 'Owner home street' },
    { q: '2AE', path: 'garaging.zip', name: 'Owner home ZIP' },
    { q: '2B0', path: 'garaging.city', name: 'Owner home city' },
    // Business address boxes, when there's no registered address to pick.
    { q: '27E', path: 'garaging.street', name: 'Business street' },
    { q: '284', path: 'garaging.zip', name: 'Business ZIP' },
    { q: '286', path: 'garaging.city', name: 'Business city' },
    { q: '230', name: 'Business name (manual entry)', ignore: true },
    { q: '233', name: 'DBA name (optional)', ignore: true },
    { q: '239', name: 'Business type', kind: 'choice', label: 'business type', value: businessType, review: (r) => (!businessType(r) ? 'Confirm the Progressive business type.' : null) },
    { q: '22D', name: 'Business structure', kind: 'choice', label: 'business structured', value: (r) => (/\b(llc|l\.l\.c|inc|corp|corporation|company|co)\.?$/i.test(r.applicant.name ?? '') ? 'Corporation or LLC / Non-Profit' : null), review: (r) => (!/\b(llc|l\.l\.c|inc|corp|corporation|company|co)\.?$/i.test(r.applicant.name ?? '') ? 'Confirm the customer’s business structure.' : null) },
    { q: '267', name: 'Type of trucker', kind: 'choice', label: 'type of trucker', value: truckerType, review: (r) => (!truckerType(r) ? 'Confirm the Progressive trucker type.' : null) },
    { q: '295', name: 'Owner first name', label: '^first name$', value: (r) => owner(r).first, review: ownerReview },
    { q: '296', name: 'Owner middle initial', ignore: true },
    { q: '297', name: 'Owner last name', label: '^last name$', value: (r) => owner(r).last, review: ownerReview },
    { q: '298', name: 'Owner suffix', ignore: true },
    { q: '29F', name: 'Owner is a driver', kind: 'bool', label: 'is a driver on the policy', value: ownerIsDriver },
    { q: '2BB', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    // The walkthrough deliberately leaves phone blank; keep the known split controls out of the
    // generic mapper so an intake phone does not silently populate them.
    { q: '2DB', name: 'Phone area code (leave blank)', ignore: true },
    { q: '2DD', name: 'Phone prefix (leave blank)', ignore: true },
    { q: '2DF', name: 'Phone line number (leave blank)', ignore: true },
    { q: '2F6', path: 'operations.hazPlacard', name: 'Hazmat placard required', label: 'hazardous material placard' },

    // --- More about the business (MoreAboutBusiness) -------------------------------------------
    { q: '77', name: 'Customer email (leave blank)', ignore: true },
    { q: '81', name: 'Currently insured', kind: 'bool', label: '^is the customer currently insured$', value: (r) => (r.priorInsurance.length ? true : null), review: (r) => (!r.priorInsurance.length ? 'Confirm whether the customer is currently insured.' : null) },
    { q: '83', name: 'Continuous coverage (standard: Yes)', kind: 'bool', label: 'continuous coverage', value: () => true },
    { q: '95', path: 'priorInsurance[0].limit', kind: 'choice', label: 'current bodily injury' },
    { q: '9D', path: 'priorInsurance[0].expiration', label: 'current policy expiration', review: expirationReview },
    { q: 'A2', name: 'Other business coverages (standard: None)', kind: 'choice', label: 'other coverages for the business', value: () => 'None' },
    { q: 'B7', name: 'Named additional insured count (preserve default)', ignore: true },
    { q: 'B8', name: 'Named waiver holder count (preserve default)', ignore: true },
    { q: 'BE', name: 'Blanket additional insured (preserve default)', ignore: true },
    { q: 'C1', name: 'Blanket waiver of subrogation (preserve default)', ignore: true },
    { q: 'CA', path: 'operations.filingsRequired', label: 'filings required', review: filingsReview },
    { q: 'D1', path: 'operations.usesEld', label: 'electronic logging', review: (r) => (r.operations.usesEld == null ? 'Confirm whether an ELD is required.' : null) },

    // --- Filings (pageName=Filings; only reached when filings are required) --------------------
    // This is a factual attestation about quote scope. Filings being requested does not prove that
    // every vehicle is included, so the agent must answer it on the portal.
    { q: 'F11', name: 'All commercially owned vehicles on this quote', kind: 'bool', label: 'all the customers commercially owned', review: (r) => (r.operations.filingsRequired === true ? 'Confirm that every commercially owned and operated vehicle is included in this quote.' : null) },
    { page: 'Filings', name: 'Federal filing', kind: 'bool', label: '^federal( liability filing)?$', value: federalFiling },
    { page: 'Filings', name: 'MCS-90 (preserve portal selection)', ignore: true, label: '^mcs ?90$' },
    { page: 'Filings', name: 'State filing (preserve portal selection)', ignore: true, label: '^state$' },

    // --- Add vehicle (AddVehicle) ----------------------------------------------------------------
    { q: '2B00', name: 'Add vehicle by VIN', kind: 'choice', label: 'add vehicle by', value: () => 'VIN' },
    { q: '2B20', path: 'vehicles[].vin' },
    { q: '2B92', path: 'garaging.zip', label: 'zip code where the vehicle' },
    // "Unlimited" / long haul becomes 501 miles, which picks "More than 500 miles".
    { q: '2B9D', name: 'Farthest one-way distance', kind: 'int', label: 'farthest one way distance', value: (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null) },
    { q: '2C05', name: 'Business / personal use', kind: 'choice', label: 'used for business personal', value: (r) => (r.operations.personalUse === false ? 'Business Only' : r.operations.personalUse ? 'Business & Personal' : null) },
    { q: '2C1A', name: 'Hauls for hire', kind: 'bool', label: 'for hire basis', value: () => true },
    { q: '2CA7', name: 'Loan / lease (standard: No)', kind: 'choice', label: 'loan lease', value: loanLease },
    { q: '2CCC', name: 'Comprehensive / collision (standard: Yes)', kind: 'bool', label: 'comprehensive or collision', value: () => true },
    { q: '2CCE', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment },
    { q: '2CE0', name: 'Attached equipment amount (range is used)', ignore: true },
    { q: '2CE3', name: 'Vehicle has no equipment', kind: 'bool', label: 'vehicle has no equipment', value: noEquipment },
    { q: '2CE8', path: 'vehicles[].value', name: 'Vehicle value if sold today', label: 'sold today', review: (r, a) => (!r.vehicles[a.vehicles ?? 0]?.value ? 'Confirm the vehicle’s actual value; this is separate from attached equipment.' : null) },

    // --- Add driver (AddDriver) ------------------------------------------------------------------
    { q: '2898', path: 'drivers[].first' },
    { q: '2899', name: 'Driver middle initial', value: (r, a) => r.drivers[a.drivers ?? 0]?.middle?.[0] ?? null },
    { q: '289A', path: 'drivers[].last' },
    { q: '28A7', path: 'drivers[].dob' },
    { q: '28AC', path: 'drivers[].licenseState', label: 'drivers license state' },
    { q: '28B9', path: 'drivers[].licenseNumber', label: 'drivers license number' },
    { q: '28C1', name: 'Exclude driver (standard: No)', kind: 'bool', label: 'exclude this driver', value: () => false },
    { q: '28F5', name: 'Accidents / claims / violations (3 yrs)', kind: 'bool', label: 'accidents claims or violations', note: 'Confirm this driver’s three-year history; the intake’s general claims box does not establish each driver’s answer.' },

    // --- Coverages and rates (CoveragesRates) ----------------------------------------------------
    { q: '1D97', path: 'coverage.autoLiabLimit', label: 'bodily injury and property damage liability' },
    { q: '1DEE', name: 'UM/UIM bodily injury (standard: $100k CSL)', kind: 'choice', value: () => '$100k CSL' },
    { q: '1E7C', name: 'Full PIP (preserve existing selection)', ignore: true },
    // These four older capture ids do not identify their column headers reliably. Keep them as
    // explicit review items so a later capture with scoped labels can be added without guessing.
    { q: '1FCD', name: 'Unresolved per-vehicle coverage column', note: 'The capture did not establish whether this column is comprehensive or collision; choose the $1,000 deductible for the active vehicle after checking its header.' },
    { q: '1FD2', name: 'Unresolved per-vehicle coverage column', note: 'The capture did not establish whether this column is comprehensive or collision; choose the $1,000 deductible for the active vehicle after checking its header.' },
    { q: '1FF2', name: 'Rental reimbursement (standard: $40/day, $1,200 max)', kind: 'choice', value: () => '$40 per day, $1,200 max', review: multiVehicleReview },
    { q: '2000', name: 'Unresolved per-vehicle coverage column', note: 'The capture did not establish whether this column is roadside; choose the intended roadside option for the active vehicle after checking its header.' },
    { q: '200F', name: 'Unresolved per-vehicle coverage column', note: 'The capture did not establish whether this column is fire/theft; leave it Not selected unless the agent confirms otherwise.' },
    { q: '207F', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment, review: multiVehicleReview },
    { q: '2158', name: 'Cargo for mobile/modular homes (standard: No)', kind: 'bool', label: 'mobile modular homes', value: () => false },
    { q: '215A', name: 'Cargo for business documents (standard: No)', kind: 'bool', label: 'business documents or non negotiable', value: () => false },
    { q: '216A', name: 'Cargo commodity category', kind: 'choice', value: (r) => commodity(r)?.category ?? null },
    { q: '216B', name: 'Cargo commodity', kind: 'choice', value: (r) => commodity(r)?.commodity ?? null },
    { q: '216F', name: 'Motor truck cargo', kind: 'choice', value: cargo },
    { q: '2150', name: 'Motor truck cargo', kind: 'choice', value: cargo },

    // --- Bill plan options (ChangePaymentPlan) ---------------------------------------------------
    { q: '3E96', name: 'Policy length (preserve 12 month selection)', ignore: true },
    { q: '3E97', name: 'Installments (preserve selection)', ignore: true },
    { q: '3E98', name: 'Payment method (standard: automatic payments)', kind: 'choice', label: 'payment method', value: () => 'Automatic payments from checking account' },
    { q: '3EA4', name: 'Installment schedule (portal calculated)', ignore: true },

    // --- Print (PrintEmailFax) ---------------------------------------------------------------
    { q: '32B0', name: 'Documents (standard: insurance quote)', kind: 'choice', value: () => 'Insurance Quote (with all bill plans)' },
    { q: '32C8', name: 'Welcome letter closing message (preserve default)', ignore: true },
    { q: '32CC', name: 'Print (standard)', kind: 'bool', value: () => true },
    { q: '32D0', name: 'Email (leave unchecked)', kind: 'bool', value: () => false },
    { q: '32DD', name: 'Fax (leave unchecked)', kind: 'bool', value: () => false },

    // --- Finish & buy (AdditionalDetails) --------------------------------------------------------
    { q: '396', name: 'Agent of Record (preserve prefill)', ignore: true },
    { q: '3E3', path: 'applicant.fein', label: 'employer identification' },
    { q: '450', name: 'Order MVR/CLUE reports', note: 'Agent decision — not filled' },

    // Known controls that are either prefilled by the agent/portal or intentionally left blank in
    // this workflow. Label fallbacks cover live pages where Duck Creek omits a stable question id.
    { label: '^agent code$', name: 'Agent code (preserve prefill)', ignore: true },
    { label: '^when should this progressive commercial auto policy start\??$', name: 'Policy start date (preserve prefill)', ignore: true },
    { label: '^quote vendor code$', name: 'Quote vendor code (preserve prefill)', ignore: true },
    { label: '^dba name$', name: 'DBA name (optional)', ignore: true },
    { label: '^(street address|apt,? building,? floor,? suite,? etc\.?|zip code|city)$', name: 'Registered address/manual entry (preserve lookup selection)', ignore: true },
    { label: '^(year|make|model)$', name: 'VIN lookup result (preserve portal value)', ignore: true },
    { label: '^agent of record$', name: 'Agent of Record (preserve prefill)', ignore: true },
    { label: '^welcome letter closing message$', name: 'Welcome letter closing message (preserve default)', ignore: true },
  ],
};
