// AmWINS Admitted Placement, Commercial Lines Business Auto
// (myagency.amwinsadmittedplacement.com/application/businessauto).
//
// A single-page application: one address for the whole application, with steps (Insured Info,
// Drivers, Vehicles, Coverages, underwriting questions) shown one at a time. Fields have stable
// element ids (#ownerDob, #mailingZip, #entityType …), so rules target them by selector; radio
// groups and unlabelled fields are matched by their name read as words ("is non profit").
// Mapped from the first recorded quote (2026-10-02): the answers below are the agent's own on
// that quote. The generic label rules still cover the rest (driver details and the like).
//
// Second quote (2026-10-02): the agent's notes became the rules below (years under own authority,
// class code search, description, NO PRIOR, gender, license year, VIN import, coverages, the
// underwriting questions all No except "other topics", and the disclosure text). The quote stops
// at the declaration: Save & Exit and Submit stay the agent's.
//
// Third quote (2026-10-02): the contact is the client (name and phone), the garage address boxes
// (no ids) are filled from the intake, each "Exclude …" box gets its own rule, "Default all
// answers to No" is clicked on the underwriting step, the second underwriting section is always
// No, Save & Continue is clicked when a step is done, and the quote starts on the Commercial
// Lines dashboard (Auto, risk state, Open New Application).
//
// Saved pages of every step (2026-10-02, layouts/amwins-html, not committed): repeating sections
// (garage, prior carrier years, drivers, vehicles) have no element ids but every field carries a
// stable data-id, so those rules target [data-id=…]. What the page's own script does, read from
// the saved application.cl.bauto.js:
// - "Contact name / Phone / Email" at the top are the AGENCY's (Agency Information); the client's
//   contact is the inspection contact (#inspectionContact*). Single contact Yes hides the
//   accounting and claims contacts.
// - One prior carrier panel per prior year: Years in Business 1-3 gives that many, 4 / 5+ / Lapse
//   three (#priorCarrierCoveragePanel0-2).
// - Import Data only opens a preview; the vehicles are added by its "Import Valid Records" button,
//   which redraws the vehicle rows (VIN, year, make, model, body type, GVW from the decoder) and
//   empties the VIN list. Typing a VIN into a row decodes it too (body type and GVW overwritten).
// - GVW is required unless the body type is a trailer.
// - Filing required Yes shows BMC-91, MCS-90, BMC-32, how long the authority has been active, how
//   long with the current carrier, and "can provide claim-free loss runs"; the DOT / MC boxes
//   show their number fields. TNI: 1 to 2 years with the current carrier (only with a DOT
//   number), claim-free loss runs No.
// - Personal Injury Protection shows for FL HI KS KY MA MI MN NJ NY ND PA UT AR DE MD OR TX NH SD
//   VA WA WI DC. TNI leaves it alone: medical payments $5K, and AmWINS applies the better one.
// - The underwriting step ends with Submit (never clicked); the other steps with Save & Continue.

import { owner } from './progressive.js';

const street = (r) => [r.garaging?.street, r.garaging?.unit].filter(Boolean).join(' ') || null;
const digits = (v) => (v ? String(v).replace(/\D/g, '') || null : null);

// Entity type from the business name, as on Progressive: LLC / Inc / Corp, otherwise a sole
// proprietor. Partnerships are never guessed.
const entityType = (r) => {
  const name = r.applicant.name ?? '';
  if (/\b(llc|l\.l\.c)\.?$/i.test(name)) return 'LLC';
  if (/\b(inc|corp|corporation|incorporated|co)\.?$/i.test(name)) return 'CORPORATION';
  return 'SOLE PROPRIETOR';
};

// Owner's full name from their driver row when found (the owner box sometimes has only the first
// name); a lone middle initial is left out.
const ownerFull = (r) => {
  const o = owner(r);
  const first = o.driver?.first ? o.driver.first.replace(/\s+[A-Za-z]\.?$/, '') : o.first;
  const name = [first, o.last].filter(Boolean).join(' ');
  return name || r.applicant.owner1 || null;
};

// Years in business: the intake's years in business, else its years under own authority.
const yearsInBusiness = (r) => {
  const n = r.applicant.yearsInBusiness ?? r.applicant.yearsExperience;
  if (n == null) return null;
  return n < 1 ? 'New Venture' : n >= 5 ? '5+' : String(n);
};
// Year established left blank on the intake means this year (TNI).
const yearEstablished = (r) => r.applicant.yearEstablished ?? new Date().getFullYear();

// Expediters and general freight haulers are 484122 (general freight trucking, long-distance,
// LTL); anything else is searched as the intake writes it, and only a single clear match is
// taken. The description follows the same split.
const isFreight = (r) => /expedit|general\s*freight/i.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);
const classSearch = (r) => (isFreight(r) ? '484122' : r.operations.businessClass ?? null);
const operationsDescription = (r) => (isFreight(r) ? 'Trucking for Hire - Other for hire trucking' : r.operations.businessClass ?? null);

const moneyK = (n) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}K` : `$${n}`);
// "Any other topics to disclose" text, from the intake, one line per item:
//   Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods
//   More than 500 miles radius of operation
//   POP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026
const disclosure = (r) => {
  const c = r.coverage;
  const lines = [];
  if (c.cargo && c.cargoLimit) {
    const goods = /general\s*freight/i.test(r.operations.whatHaul ?? '') ? 'Consumer Goods / Other Consumer Goods' : r.operations.whatHaul;
    lines.push(`Motor Truck Cargo ${moneyK(c.cargoLimit)} with ${moneyK(c.cargoDeductible ?? 1000)} Ded${goods ? ` - ${goods}` : ''}`);
  }
  const miles = radius(r);
  if (miles) lines.push(miles > 500 ? 'More than 500 miles radius of operation' : `${miles} miles radius of operation`);
  const p = r.priorInsurance?.[0];
  if (p?.carrier) {
    const kind = /commercial/i.test(p.type ?? '') ? 'Commercial' : /personal/i.test(p.type ?? '') ? 'Personal' : p.type;
    const carrier = p.carrier.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
    lines.push(['POP', kind].filter(Boolean).join(' ') + ` - ${carrier}${p.limit ? ` - ${p.limit}` : ''}${p.expiration ? ` - Exp Date ${p.expiration}` : ''}`);
  }
  return lines.join('\n') || null;
};

// Body type as on the intake: a Van is a Cargo Van.
const bodyType = (r, a) => {
  const t = r.vehicles?.[a.vehicles ?? 0]?.type ?? null;
  return t && /^van$/i.test(t.trim()) ? 'Cargo Van' : t;
};
const licenseYear = (r, a) => {
  const dob = r.drivers?.[a.drivers ?? 0]?.dob;
  const y = dob ? Number(String(dob).slice(-4)) : NaN;
  return Number.isFinite(y) ? String(y + 17) : null;
};

// Underwriting questions TNI answers No (both sections), by the field names AmWINS uses.
const UNDERWRITING_NO = [
  'subsidiary to other', 'subsidiary', 'safety info', 'hazard exposure', 'other insurance', 'coverage denial',
  'past criminal activity', 'criminal activity in past ?5 ?years', 'code vo\\w*ation', 'finacial default', 'financial default',
  'finacial judgement', 'financial judgement', 'trust', 'foreign operations', 'other venture', 'own drones',
  'hire other to operate drones', 'use their auto', 'vehicle maintenance program', 'vehicle used by family',
  'recruiting method', 'covered by wc', 'convictions moving violations',
];

const filings = (r) => (r.operations.filingsRequired === true ? true : r.operations.filingsRequired === false ? false : null);

// Radius bands: "< 50 MILES", "51 - 100 MILES", "101- 200 MILES", "201 + MILES". Unlimited / long
// haul is the top band.
const radius = (r) => r.operations.radiusMiles ?? (/unlimited|long|nation|otr|48|any/i.test(r.operations.radius ?? '') ? 501 : null);

// The dashboard's address is spelled both ways.
const START_PAGES = ['/commerciallines', '/CommercialLines'];

// Fields in repeating sections, by the data-id the page gives them.
const dataId = (id, within = '') => `${within ? `${within} ` : ''}[data-id="${id}"]`;
const DRIVER = '#driversPanel';
const VEHICLE = '#vehiclesPanel';

// "How long has the insured's current federal operating authority been active?", from the
// intake's years under its own authority.
const authorityAge = (r) => {
  const n = r.applicant.yearsExperience;
  if (n == null) return !r.applicant.mc && !r.applicant.dot ? 'NO AUTHORITY' : null;
  return n < 1 ? 'LESS THAN 1 YEAR' : n < 2 ? '1 TO 2 YEARS' : n < 3 ? '2 TO 3 YEARS' : 'MORE THAN 3 YEARS';
};
// Federal filings from the intake's "which filings": liability means BMC-91 (MCS-90 comes with
// it); cargo means BMC-32. Unknown when the intake doesn't say which.
const filingsText = (r) => (filings(r) ? r.operations.filingsWhich ?? null : null);
const federalLiability = (r) => { const t = filingsText(r); return t == null ? null : /liab|bmc.?91|mcs.?90|federal/i.test(t); };
const federalCargo = (r) => { const t = filingsText(r); return t == null ? null : /cargo|bmc.?3[24]/i.test(t); };

// Coverages that each have an "Exclude …" box (spelled Exclude / Exlucde / Exlude on the page).
const EXCLUSIONS = ['medical', 'uninsured', 'comprehensive', 'collision', 'transportation|rental', 'towing'];

const vehicleValueNote = (r, a) => {
  const v = r.vehicles?.[a.vehicles ?? 0]?.value;
  return v != null && typeof v !== 'number' ? `The intake's vehicle value "${v}" isn't a dollar amount: enter it yourself.` : null;
};

export const amwins = {
  id: 'amwins',
  name: 'AmWINS',
  hosts: [/(^|\.)amwinsadmittedplacement\.com$/],
  // No answer waits on the server (timing of the first three quotes: 0 of 294 answers sent a
  // request): fill a round of answers at a time.
  batch: true,
  // Import Data right after the VIN list is filled, before the vehicle boxes, which it fills.
  actions: [
    // Start: the Auto tile opens the risk state box; Open New Application once the state is in.
    { id: 'autoApplication', page: START_PAGES, text: '^auto$', unlessActions: ['openApplication'] },
    { id: 'openApplication', page: START_PAGES, text: '^open new application$', after: ['amwins.riskState'] },
    { id: 'importVins', text: '^import data$', after: ['amwins.vinList'], immediate: true },
    // Import Data only shows a preview: this adds the vehicles (and redraws their rows).
    { id: 'importVinRecords', text: '^import valid records$', afterActions: ['importVins'], immediate: true },
    // Underwriting: answers every General Information question No in one go (before the rules
    // below answer them one at a time; "other topics" is set back to Yes afterwards).
    { id: 'defaultNo', text: '^default all answers to\\W*no\\W*$', immediate: true },
  ],
  // Each step ends with Save & Continue (saves the draft, opens the next step) once nothing is
  // left for the agent. The declaration step never gets there: the declaration is the agent's.
  advance: { text: '^save\\s*(&|and)\\s*continue$' },
  rules: [
    // --- Start (/commerciallines) --------------------------------------------------------------
    { name: 'Risk state', label: 'select a risk state', path: 'amwins.riskState', kind: 'state', value: (r) => r.garaging?.state ?? null },

    // --- Insured Info --------------------------------------------------------------------------
    // The agency's own details, effective dates and inspection contacts are left as the page has them.
    // Agency Information (#agnecyName, #contactName, #phone, #email are the agency's), website,
    // DBA and policy dates stay as the page has them.
    ...['#agnecyName', '#contactName', '#phone', '#email', '#website', '#effectiveDate', '#expirationDate', '#dba',
      '#inspectionContactEmail', '#inspectionContactMobilePhone']
      .map((selector) => ({ selector, name: `Left as the page has it (${selector.slice(1)})`, ignore: true })),
    // Contact Information: the client, name and phone only; single contact stays Yes.
    { selector: '#inspectionContactName', name: 'Contact name (the owner)', value: ownerFull },
    { selector: '#inspectionContactOfficePhone', name: 'Contact phone', value: (r) => digits(r.applicant.phone) },
    { selector: '#name', name: 'Named insured (company, else the owner)', value: (r) => r.applicant.name || ownerFull(r) },
    { selector: '#ownerName', name: 'Owner full name', value: ownerFull },
    { selector: '#ownerDob', name: 'Owner date of birth', kind: 'date', value: (r) => owner(r).driver?.dob ?? null },
    { selector: '#mailingAddress', name: 'Mailing street', value: street },
    { selector: '#mailingCity', path: 'garaging.city' },
    { selector: '#mailingState', path: 'garaging.state' },
    { selector: '#mailingZip', path: 'garaging.zip' },
    { selector: '#businessPhone', name: 'Business phone', value: (r) => digits(r.applicant.phone) },
    { selector: '#entityType', name: 'Entity type', kind: 'choice', value: entityType },
    { selector: '#yrsInBusiness', name: 'Years in business', kind: 'choice', value: yearsInBusiness },
    { selector: '#yearBusinessEstablished', name: 'Year established', value: yearEstablished },
    { name: 'Non-profit (standard: No)', label: '^is non profit$', kind: 'bool', value: () => false },
    { name: 'Single contact (standard: Yes)', label: '^is single contact$', kind: 'bool', value: () => true },
    { name: 'Garage address same as mailing (standard)', label: '^same as mailing address', kind: 'bool', value: () => true },
    // The box doesn't copy the address over: the garage boxes are filled too.
    { selector: dataId('address', '#garagePanel'), name: 'Garage street', value: street },
    { selector: dataId('city', '#garagePanel'), name: 'Garage city', path: 'garaging.city' },
    { selector: dataId('state', '#garagePanel'), name: 'Garage state', kind: 'state', value: (r) => r.garaging?.state ?? null },
    { selector: dataId('zip', '#garagePanel'), name: 'Garage ZIP', path: 'garaging.zip' },
    { selector: '#natureOfBusiness', name: 'Nature of business', kind: 'choice', value: () => 'TRANSPORTATION' },
    { selector: '#retailOrServiceOperationPert', name: 'Retail / service operations % (trucking: 0)', value: () => '0' },
    { selector: '#classCodeAndDescription', name: 'Classification (484122 for expediters / general freight)', kind: 'search-select', search: classSearch, value: classSearch },
    { selector: '#operationDescription', name: 'Description of operations', value: operationsDescription },
    { name: 'Additional interest (standard: No)', label: '^has additional interest$', kind: 'bool', value: () => false },
    { selector: '#waiverType', name: 'Waiver type (standard: NONE)', kind: 'choice', value: () => 'NONE' },
    // Filing counts: skipped (TNI).
    ...['#stateFillings', '#stateCargoFillings', '#otherFillings'].map((selector) => ({ selector, name: 'Filing count (skipped)', ignore: true })),
    // Every prior year's carrier: NO PRIOR (the proof of prior insurance goes in the disclosure).
    ...[0, 1, 2].map((n) => ({ selector: dataId('carrierName', `#priorCarrierCoveragePanel${n}`), name: `Prior carrier, year ${n} (standard: NO PRIOR)`, kind: 'choice', value: () => 'NO PRIOR' })),
    { name: 'Filings required', label: '^filling required$', kind: 'bool', value: filings },
    { selector: '#hasDotNumber', name: 'Has a DOT number', kind: 'bool', value: (r) => !!r.applicant.dot },
    { selector: '#hasMcNumber', name: 'Has an MC number', kind: 'bool', value: (r) => !!r.applicant.mc },
    { selector: '#noNumber', name: 'No DOT / MC number', kind: 'bool', value: (r) => !r.applicant.dot && !r.applicant.mc },
    { selector: '#dotNumber', name: 'DOT number', value: (r) => digits(r.applicant.dot) },
    { selector: '#mcNumber', name: 'MC number', value: (r) => digits(r.applicant.mc) },
    // Shown with Filing required Yes.
    { selector: '#howLongFederalOperatingAuthorityActive', name: 'Federal authority active for (years under own authority)', kind: 'choice', value: authorityAge },
    { name: 'Federal BMC-91', label: '^federal bmc91$', kind: 'bool', value: federalLiability },
    { name: 'Federal liability MCS-90', label: '^federal liability mcs90$', kind: 'bool', value: federalLiability },
    { name: 'Federal cargo BMC-32', label: '^federal cargo bmc32$', kind: 'bool', value: federalCargo },
    // TNI: 1 to 2 years, only asked of clients with a DOT number.
    { selector: '#howLongWithCurrentCarrier', name: 'How long with the current carrier (TNI: 1 to 2 years with a DOT)', kind: 'choice', value: () => '1 TO 2 YEARS', ignore: (r) => !r.applicant.dot },
    { name: 'Claim-free loss runs (TNI: No)', label: '^can provide claim free loss run$', kind: 'bool', value: () => false },
    { name: 'Valued loss runs (standard: No)', label: '^valued loss runs$', kind: 'bool', value: () => false },
    // No by default; Yes only when the intake reports claims (Yes opens the required Loss History).
    { name: 'Any prior loss (default: No)', label: '^any prior loss$', kind: 'bool', value: (r) => r.claims?.hasClaims === true },

    // --- Drivers ---------------------------------------------------------------------------------
    // Names and license number first: they retitle the driver panel; gender, marital status and
    // license year after them.
    { selector: dataId('firstName', DRIVER), path: 'drivers[].first' },
    { selector: dataId('middleName', DRIVER), name: 'Middle name (only when the intake has one)', path: 'drivers[].middle', ignore: (r, a) => !r.drivers?.[a.drivers ?? 0]?.middle },
    { selector: dataId('lastName', DRIVER), path: 'drivers[].last' },
    { selector: dataId('dateOfBirth', DRIVER), path: 'drivers[].dob' },
    { selector: dataId('licenseNumber', DRIVER), path: 'drivers[].licenseNumber' },
    { selector: dataId('licenseState', DRIVER), path: 'drivers[].licenseState' },
    { selector: dataId('gender', DRIVER), name: 'Gender (standard: MALE)', kind: 'choice', value: () => 'MALE' },
    // Not on the intake: Married, flagged for the agent to confirm.
    { selector: dataId('martialStatus', DRIVER), name: 'Marital status', kind: 'choice', value: (r, a) => r.drivers?.[a.drivers ?? 0]?.maritalStatus || 'MARRIED',
      warn: (r, a) => (r.drivers?.[a.drivers ?? 0]?.maritalStatus ? null : 'The intake has no marital status: Married was picked. Check it.') },
    { selector: dataId('licenseYear', DRIVER), name: 'Year licensed (birth year + 17)', value: licenseYear },

    // --- Vehicles --------------------------------------------------------------------------------
    { name: 'File upload (not used)', label: '^select files?', ignore: true },
    { selector: '#vehLookupVin', path: 'amwins.vinList', name: 'VINs to look up (one per line)', value: (r) => r.vehicles.map((v) => v.vin).filter(Boolean).join('\n') || null },
    { selector: dataId('locationNumber', VEHICLE), name: 'Vehicle location (the first, the insured)', kind: 'first-option', value: () => 'first option' },
    // VIN, year, make, model come from Import Data (its wording wins); typed only when it found
    // nothing.
    { selector: dataId('vin', VEHICLE), path: 'vehicles[].vin', trustPage: true },
    { selector: dataId('year', VEHICLE), path: 'vehicles[].year', trustPage: true },
    { selector: dataId('make', VEHICLE), path: 'vehicles[].make', trustPage: true },
    { selector: dataId('model', VEHICLE), path: 'vehicles[].model', trustPage: true },
    // The VIN decoder writes its own body type; the intake's wins (Box Truck, Cargo Van).
    { selector: dataId('bodyType', VEHICLE), name: 'Body type (as on the intake)', value: bodyType, replace: true },
    // From the VIN decoder; required, so flagged only when it stays empty.
    { selector: dataId('grossVehicleWeight', VEHICLE), name: 'GVW (from Import Data)', ignore: true, emptyNote: 'GVW comes from Import Data / the VIN; it stayed empty, so enter it from the registration.' },
    { selector: '#marketValue', path: 'vehicles[].value', name: 'Vehicle value', note: vehicleValueNote },
    { selector: dataId('usageType', VEHICLE), name: 'Usage type (standard: For hire)', kind: 'choice', value: () => 'FOR HIRE' },
    { selector: dataId('radius', VEHICLE), name: 'Radius', kind: 'int', value: radius },
    { name: 'Permanently attached equipment (standard: No)', label: '^permanently attached equipment', kind: 'bool', value: () => false },

    // --- Coverages -------------------------------------------------------------------------------
    { name: 'CSL liability limit', label: '^csl liability limit$', path: 'coverage.autoLiabLimit' },
    { name: 'Uninsured motorists (standard: Yes)', label: '^uninsured motorists$', kind: 'bool', value: () => true },
    { name: 'Rental reimbursement (standard: $40/day, $1,200)', label: 'transportation expense|rental reimbursement', kind: 'choice', value: () => '$40 day / $1,200 total' },
    { selector: '#uninsuredMotoristsLimit', name: 'UM limit (standard: $100K)', kind: 'choice', value: () => '$100K' },
    { selector: '#medicalPayment', name: 'Medical payments (standard: $5,000)', kind: 'choice', value: () => '$5,000' },
    { selector: '#comprehensiveDeductible', name: 'Comprehensive deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000' },
    { selector: '#collisionDeductible', name: 'Collision deductible (standard: $1,000)', kind: 'choice', value: () => '$1,000' },
    { name: 'Waiver of collision (standard: No)', label: '^has waiver of collision$', kind: 'bool', value: () => false },
    { selector: '#towingAndLaborReimbursement', name: 'Towing and labor (standard: $75)', kind: 'choice', value: () => '$75' },
    // TNI leaves PIP alone: medical payments $5K is chosen and AmWINS applies the better of the two.
    { name: 'Personal Injury Protection (left alone)', label: '^personal injury protection$', ignore: true },
    { selector: '#personalInjuryProtectionLimit', name: 'Personal Injury Protection limit (left alone)', ignore: true },
    // Liability auto symbol: 6 only.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ selector: `#autoSymbol${n}`, name: `Auto symbol ${n}${n === 6 ? ' (TNI: 6)' : ''}`, kind: 'bool', value: () => n === 6 })),
    // Nothing is excluded: one rule per box (a rule fills one field).
    ...EXCLUSIONS.map((topic) => ({ name: `Exclude ${topic.split('|')[0]} (standard: not excluded)`, label: `^ex\\w*de\\b.*(${topic})`, kind: 'bool', value: () => false })),

    // --- Underwriting questions --------------------------------------------------------------------
    { name: 'Vehicles not owned (standard: No)', label: '^any vehicle not owned$', kind: 'bool', value: () => false },
    { name: 'Vehicles leased (standard: No)', label: '^vehicle leased$', kind: 'bool', value: () => false },
    { name: 'MVR verification (agent answer: No)', label: '^mvr verification$', kind: 'bool', value: () => false },
    { name: 'Owned unscheduled vehicles (standard: No)', label: '^owned unscheduled vehicle$', kind: 'bool', value: () => false },
    { name: 'Hazardous material', label: '^transporting hazardous material$', kind: 'bool', path: 'operations.hazmat' },
    ...UNDERWRITING_NO.map((q) => ({ name: `Underwriting: ${q.replace(/[?\\]/g, '')} (standard: No)`, label: `^${q}$`, kind: 'bool', value: () => false })),
    // Yes again after "Default all answers to No".
    { name: 'Other topics to disclose (standard: Yes)', label: '^other topic$', kind: 'bool', value: () => true, replace: true },
    { name: 'Disclosure details (from the intake)', label: '^disclosure details$', value: disclosure },
    // The declaration is the agent's to make.
    { selector: '#accept', name: 'Declaration', kind: 'bool', note: 'The declaration is yours to confirm; never ticked. Then Submit (yours too).' },
  ],
};
