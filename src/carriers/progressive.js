// Progressive commercial auto, ForAgentsOnly (clpolicy.foragentsonly.com).
//
// The quote flow is an ExtJS 6 + Duck Creek ("DCT") single-page app. Every field is keyed by a
// Duck Creek question id (`q`), taken from the element id / field name; `label` is a fallback
// regex on the question text in case Progressive renumbers. Mapped from live MD for-hire
// expediter quotes (captures/progressive/). Questions that exist only in other states or for
// other products are skipped when they aren't on the page, and the generic label rules still
// apply to anything not listed here.
//
// Rules either read a record path, or compute a value with `value(record, active)` when
// Progressive words the answer differently from the intake form. `note` rules are questions the
// agent must answer themselves; they're marked, never filled.
//
// Follow-up questions the intake doesn't cover use TNI's standard answers (the agent's own
// choices on live quotes). The agent changes them for the exceptions.

const digits = (s) => String(s ?? '').replace(/\D/g, '');

// The business owner, matched to their driver row (for date of birth and a clean name split).
function owner(r) {
  const full = r.applicant.owner1 ?? '';
  const last = full.split(/\s+/).at(-1)?.toLowerCase();
  const driver = r.drivers.find((d) => last && d.last?.toLowerCase() === last) ?? null;
  const first = driver?.first ?? full.split(/\s+/).slice(0, -1).join(' ');
  return { driver, first: first || null, middle: driver?.middle ?? null, last: driver?.last ?? full.split(/\s+/).at(-1) ?? null };
}

// "Is the customer currently insured with Progressive Commercial Auto?" Yes only when the
// intake's current-insurance section is a Progressive *commercial* auto policy filled out with
// the coverage (limit) and the expiration date. A Progressive personal auto policy doesn't count.
const insuredWithProgressive = (r) => {
  const p = r.priorInsurance[0];
  return !!(p && p.type === 'Commercial Auto' && /progressive/i.test(p.carrier ?? '') && p.limit && p.expiration);
};

// After a USDOT lookup Progressive offers the registered business name / address as a choice,
// next to "Enter a different …". Agents pick the registered one. Without a USDOT number there is
// no such choice: the manual boxes are the only option and get the intake's values (below and
// in the generic address rules).
const registered = (prefer) => ({ kind: 'pick-not', value: () => ({ not: '^enter a different', prefer }) });

// Always "$0 to $2,000" at TNI; the agent changes it for the rare exception.
const equipment = () => '$0 to $2,000';

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

const filings = (r) => (r.operations.filingsRequired ? true : null);

// Progressive's business type (and, for trucking, the type of trucker) for what the intake
// calls the business. Expediters are "For Hire Trucking" / "Other For-Hire Trucking".
const isExpediter = (r) => /expedit/i.test(r.operations.businessClass ?? '');
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
  // Never flagged as "needs you" when empty: the agent fills these only when they apply.
  optional: ['296', '298', '233', '1CC', '2899', '2A9'],
  // Progressive pre-selects some answers (filings No, $750k CSL, manual payments, rental "Not
  // selected"). Those are replaced when ours differ; anything the agent changed is left alone.
  replaceChoices: true,
  // Buttons the filler clicks, in order, each once per quote, only on its page and only once
  // `after` (any of these fields) has a value. `unless`: skip when any of these has a value.
  // `text` is a regex on the button's text, `token` a string in its id/href/onclick.
  // Never clicked, whatever a rule says: Continue, Next, Finish, Buy, Bind, Submit, Save.
  actions: [
    { id: 'verifyDot', page: 'BusinessOwnerInfo', text: '^verify( us)?( ?dot)?( number)?$', after: ['applicant.dot'], immediate: true },
    { id: 'vehicleTile', page: 'MostCommonVehicles', text: vehicleTile },
    { id: 'lookupVin', page: 'AddVehicle', text: '^look ?up( vin)?$', after: ['vehicles[].vin'], immediate: true },
    // The "+" in the Motor Truck Cargo row (every coverage has one).
    { id: 'openCargo', page: 'CoveragesRates', text: '^\\+$', near: 'motor truck cargo', unless: ['progressive.q2150', 'progressive.q216F'], when: (r) => r.coverage.cargo === true },
    { id: 'billPlan', page: 'CoveragesRates', text: '^(view )?bill plan options?$', after: (r) => (r.coverage.cargo ? ['progressive.q2150', 'progressive.q216F'] : ['coverage.autoLiabLimit']) },
    // "Print, Email, Fax": from the bill plan page once automatic payments is chosen, or back on
    // coverages after the bill plan page.
    { id: 'print', page: 'ChangePaymentPlan', text: PRINT_EMAIL_FAX, afterValue: ['progressive.q3E98', 'automatic'] },
    { id: 'print', page: 'CoveragesRates', text: PRINT_EMAIL_FAX, afterPages: ['ChangePaymentPlan'] },
    { id: 'printSend', page: 'PrintEmailFax', text: '^print ?/ ?send$', after: ['progressive.q32CC'] },
  ],
  rules: [
    // --- Named Insured and Business Overview (pageName=BusinessOwnerInfo) ---------------------
    { q: '198', name: 'Currently insured with Progressive Commercial Auto', kind: 'bool', value: insuredWithProgressive },
    { q: '1ED', name: 'Has a USDOT number', kind: 'choice', value: (r) => {
      if (r.applicant.dot) return 'Yes - the customer has a USDOT number';
      if (r.applicant.mcDotWithin60Days === true) return 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days';
      if (r.applicant.mcDotWithin60Days === false) return 'No - and the customer will not have a USDOT number';
      return null;
    } },
    { q: '1F3', path: 'applicant.dot', label: 'usdot number' },
    { q: '20F', name: 'Question after USDOT lookup (standard: Yes)', kind: 'bool', value: (r) => (r.applicant.dot ? true : null) },
    { q: '22F', name: 'Business name (USDOT record)', ...registered() },
    { q: '277', name: 'Primary business address (USDOT record)', ...registered() },
    { q: '2A5', name: 'Owner home address', ...registered('primary business address') },
    // Owner home address boxes, shown when there's no registered address to pick.
    { q: '2AA', path: 'garaging.street', name: 'Owner home street' },
    { q: '2AE', path: 'garaging.zip', name: 'Owner home ZIP' },
    { q: '2B0', path: 'garaging.city', name: 'Owner home city' },
    // Business address boxes, when there's no registered address to pick.
    { q: '27E', path: 'garaging.street', name: 'Business street' },
    { q: '284', path: 'garaging.zip', name: 'Business ZIP' },
    { q: '286', path: 'garaging.city', name: 'Business city' },
    { q: '239', name: 'Business type', kind: 'choice', label: 'business type', value: businessType },
    { q: '22D', name: 'Business structure', kind: 'choice', label: 'business structured', value: (r) => (/\b(llc|l\.l\.c|inc|corp|corporation|company|co)\.?$/i.test(r.applicant.name ?? '') ? 'Corporation or LLC / Non-Profit' : null) },
    { q: '267', name: 'Type of trucker', kind: 'choice', label: 'type of trucker', value: truckerType },
    { q: '295', name: 'Owner first name', label: '^first name$', value: (r) => owner(r).first },
    { q: '296', name: 'Owner middle initial', value: (r) => owner(r).middle?.[0] ?? null },
    { q: '297', name: 'Owner last name', label: '^last name$', value: (r) => owner(r).last },
    { q: '2BB', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    { q: '2DB', name: 'Phone area code', value: (r) => digits(r.applicant.phone).slice(0, 3) || null },
    { q: '2DD', name: 'Phone prefix', value: (r) => digits(r.applicant.phone).slice(3, 6) || null },
    { q: '2DF', name: 'Phone line number', value: (r) => digits(r.applicant.phone).slice(6, 10) || null },
    { q: '2F6', path: 'operations.hazPlacard', name: 'Hazmat placard required', label: 'hazardous material placard' },

    // --- More about the business (MoreAboutBusiness) -------------------------------------------
    { q: '77', path: 'applicant.email', label: 'customer email' },
    { q: '81', name: 'Currently insured', kind: 'bool', label: '^is the customer currently insured$', value: (r) => (r.priorInsurance.length ? true : null) },
    { q: '83', name: 'Continuous coverage (standard: Yes)', kind: 'bool', label: 'continuous coverage', value: () => true },
    { q: '95', path: 'priorInsurance[0].limit', kind: 'choice', label: 'current bodily injury' },
    { q: '9D', path: 'priorInsurance[0].expiration', label: 'current policy expiration' },
    { q: 'A2', name: 'Other business coverages (standard: None)', kind: 'choice', label: 'other coverages for the business', value: () => 'None' },
    { q: 'CA', path: 'operations.filingsRequired', label: 'filings required' },
    { q: 'D1', path: 'operations.usesEld', label: 'electronic logging' },

    // --- Filings (pageName=Filings; only reached when filings are required) --------------------
    { q: 'F11', name: 'All commercially owned vehicles on this quote', kind: 'bool', label: 'all the customers commercially owned', value: filings },
    { label: '^federal$', name: 'Federal filing', kind: 'bool', value: filings },
    { label: '^mcs ?90$', name: 'MCS-90', kind: 'bool', value: filings },

    // --- Add vehicle (AddVehicle) ----------------------------------------------------------------
    { q: '2B20', path: 'vehicles[].vin' },
    { q: '2B92', path: 'garaging.zip', label: 'zip code where the vehicle' },
    // "Unlimited" / long haul becomes 501 miles, which picks "More than 500 miles".
    { q: '2B9D', name: 'Farthest one-way distance', kind: 'int', label: 'farthest one way distance', value: (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null) },
    { q: '2C05', name: 'Business / personal use', kind: 'choice', label: 'used for business personal', value: (r) => (r.operations.personalUse === false ? 'Business Only' : r.operations.personalUse ? 'Business & Personal' : null) },
    { q: '2C1A', name: 'Hauls for hire', kind: 'bool', label: 'for hire basis', value: (r) => (r.applicant.mc ? true : null) },
    { q: '2CA7', name: 'Loan / lease (standard: No)', kind: 'choice', label: 'loan lease', value: () => 'No' },
    { q: '2CCC', name: 'Comprehensive / collision (standard: Yes)', kind: 'bool', label: 'comprehensive or collision', value: () => true },
    { q: '2CCE', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment },
    { q: '2CE3', name: 'Vehicle has no equipment (standard)', kind: 'bool', label: 'vehicle has no equipment', value: () => true },
    { q: '2CE8', path: 'vehicles[].value', name: 'Vehicle value if sold today', label: 'sold today' },

    // --- Add driver (AddDriver) ------------------------------------------------------------------
    { q: '2898', path: 'drivers[].first' },
    { q: '2899', name: 'Driver middle initial', value: (r, a) => r.drivers[a.drivers ?? 0]?.middle?.[0] ?? null },
    { q: '289A', path: 'drivers[].last' },
    { q: '28A7', path: 'drivers[].dob' },
    { q: '28AC', path: 'drivers[].licenseState', label: 'drivers license state' },
    { q: '28B9', path: 'drivers[].licenseNumber', label: 'drivers license number' },
    { q: '28C1', name: 'Exclude driver (standard: No)', kind: 'bool', label: 'exclude this driver', value: () => false },
    { q: '28F5', path: 'claims.hasClaims', name: 'Accidents / claims / violations (3 yrs)', kind: 'bool', label: 'accidents claims or violations' },

    // --- Coverages and rates (CoveragesRates) ----------------------------------------------------
    { q: '1D97', path: 'coverage.autoLiabLimit', label: 'bodily injury and property damage liability' },
    { q: '1FF2', name: 'Rental reimbursement (standard: $40/day, $1,200 max)', kind: 'choice', value: () => '$40 per day, $1,200 max' },
    { q: '207F', name: 'Attached equipment value (standard: $0 to $2,000)', kind: 'choice', value: equipment },
    { q: '2158', name: 'Cargo for mobile/modular homes (standard: No)', kind: 'bool', label: 'mobile modular homes', value: () => false },
    { q: '215A', name: 'Cargo for business documents (standard: No)', kind: 'bool', label: 'business documents or non negotiable', value: () => false },
    { q: '216A', name: 'Cargo commodity category', kind: 'choice', value: (r) => commodity(r)?.category ?? null },
    { q: '216B', name: 'Cargo commodity', kind: 'choice', value: (r) => commodity(r)?.commodity ?? null },
    { q: '216F', name: 'Motor truck cargo', kind: 'choice', value: cargo },
    { q: '2150', name: 'Motor truck cargo', kind: 'choice', value: cargo },

    // --- Bill plan options (ChangePaymentPlan) ---------------------------------------------------
    { q: '3E98', name: 'Payment method (standard: automatic payments)', kind: 'choice', label: 'payment method', value: () => 'Automatic payments' },

    // --- Print (PrintEmailFax) ---------------------------------------------------------------
    { q: '32B0', name: 'Documents (standard: insurance quote)', kind: 'choice', value: () => 'Insurance Quote (with all bill plans)' },
    { q: '32CC', name: 'Print (standard)', kind: 'bool', value: () => true },

    // --- Finish & buy (AdditionalDetails) --------------------------------------------------------
    { q: '3E3', path: 'applicant.fein', label: 'employer identification' },
    { q: '450', name: 'Order MVR/CLUE reports', note: 'Agent decision — not filled' },
  ],
};
