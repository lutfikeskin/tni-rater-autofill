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
// Rule sources (plan.js `source`): `derived` reads the intake, `standard` is TNI's coverage or
// workflow choice (tagged in the panel; a check item in review mode), `fact` / `attestation` is
// never filled (2026-10-09: valued loss runs and blank marital status are the agent's;
// 2026-10-19: 1 TO 2 YEARS with the current carrier and no claim-free loss runs; 2026-10-10: gender is MALE unless set in client details, year licensed birth year + 17; attached equipment follows the intake; additional interest and
// the underwriting questions are No, and a blank years in business is a new venture).
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
//   show their number fields. How long with the current carrier (only asked with a DOT number)
//   and claim-free loss runs aren't on the intake: TNI's standards (1 TO 2 YEARS, No).
// - Personal Injury Protection shows for FL HI KS KY MA MI MN NJ NY ND PA UT AR DE MD OR TX NH SD
//   VA WA WI DC. TNI: No, since Medical Payments ($5K) is always offered and preferred.
// - The underwriting step ends with Submit (never clicked); the other steps with Save & Continue.

import { owner } from './progressive.js';
import { isLongHaul, otherNotes } from '../normalize.js';
import { noPriorInsurance, priorPolicyExpired } from '../util.js';

const street = (r) => [r.garaging?.street, r.garaging?.unit].filter(Boolean).join(' ') || null;
const digits = (v) => (v ? String(v).replace(/\D/g, '') || null : null);

// Entity type from the company name, as on Progressive (22D): LLC / Inc / Corp by the suffix, no
// company name is a sole proprietor, and a company name without a suffix is the agent's.
// Partnerships are never guessed.
const entityType = (r) => {
  const name = String(r.applicant.name ?? '').trim();
  if (/\b(llc|l\.l\.c)\.?$/i.test(name)) return 'LLC';
  if (/\b(inc|corp|corporation|incorporated|company|co)\.?$/i.test(name)) return 'CORPORATION';
  return name ? null : 'SOLE PROPRIETOR';
};
const entityTypeNote = (r) => (entityType(r) == null
  ? `The company name "${r.applicant.name}" has no LLC / Inc / Corp suffix, so its entity type isn't known: answer it yourself.` : null);

// Facts the intake doesn't supply are the agent's (plan.js: `source: 'fact'` is never filled).
// `clientFact` marks a client fact the intake may answer: when it doesn't, the agent's too (the AI
// assistant leaves it).
const fact = (name, note) => ({ name, source: 'fact', note });

// Permanently attached equipment: any value on the intake is the agent's (AmWINS asks Yes / No and
// details); none given is No, TNI's standard (as Progressive's "no equipment"), and an explicit $0
// on the intake is No derived from it.
const equipment = (r) => (r.operations?.equipVehicle > 0 ? null : false);
const equipmentSource = (r) => (r.operations?.equipVehicle == null ? 'standard' : 'derived');
const equipmentNote = (r) => (r.operations?.equipVehicle > 0 ? `The intake gives $${r.operations.equipVehicle.toLocaleString('en-US')} of attached equipment: answer it (and its details) yourself.` : null);

// Owner's full name from their driver row when found (the owner box sometimes has only the first
// name); a lone middle initial is left out.
const ownerFull = (r) => {
  const o = owner(r);
  const first = o.driver?.first ? o.driver.first.replace(/\s+[A-Za-z]\.?$/, '') : o.first;
  const name = [first, o.last].filter(Boolean).join(' ');
  return name || r.applicant.owner1 || null;
};

// Years in business: the intake's years in business, else its years under own authority; neither
// is TNI's standard 0, a new venture established this year (2026-10-09). Check intake warns
// (years-in-business.default), and Luna points out a claims-box line saying how long it has run.
const businessYears = (r) => r.applicant.yearsInBusiness ?? r.applicant.yearsExperience ?? null;
const yearsInBusiness = (r) => {
  const n = businessYears(r) ?? 0;
  return n < 1 ? 'New Venture' : n >= 5 ? '5+' : String(n);
};
const yearsSource = (r) => (businessYears(r) == null ? 'standard' : 'derived');
// Year established: the intake's, else this year (TNI's standard, as on the recorded quotes).
const yearEstablished = (r) => r.applicant.yearEstablished ?? new Date().getFullYear();
const establishedSource = (r) => (r.applicant.yearEstablished == null ? 'standard' : 'derived');

// Expediters and general freight haulers are 484122 (general freight trucking, long-distance,
// LTL), nature of business TRANSPORTATION, usage FOR HIRE and the for-hire description. Any other
// business class is the agent's for all four (2026-10-09; review mode covers its standards).
// One pattern for these answers and the review-mode gate (supportedClasses): a class it doesn't
// match fills in review mode, so a "Freight Hauler" of furniture gets both the notes and the review.
const FREIGHT = /expedit|general\s*freight/i;
const isFreight = (r) => FREIGHT.test(`${r.operations.businessClass ?? ''} ${r.operations.whatHaul ?? ''}`);
const freightNote = (what) => (r) => (isFreight(r) ? null : `${what} for a ${r.operations.businessClass || 'business of this class'} isn't known: answer it yourself.`);
const classSearch = (r) => (isFreight(r) ? '484122' : null);
// AmWINS lists several results for 484122: the one TNI picks, in full.
const CLASS_484122 = '484122 - General freight trucking, long-distance, less-than-truckload (LTL)';
const classChoice = (r) => (isFreight(r) ? CLASS_484122 : null);
const operationsDescription = (r) => (isFreight(r) ? 'Trucking for Hire - Other for hire trucking' : null);

const moneyK = (n) => (n >= 1e6 ? `$${n / 1e6}M` : n >= 1e3 ? `$${n / 1e3}K` : `$${n}`);
// "Any other topics to disclose" text, from the intake, one line per item:
//   Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods
//   More than 500 miles radius of operation
//   Trailer - 2015 Great Dane Dry Van - VIN 1GRAA0621FB700000 - $25K
//   POP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026
// AmWINS has no trailer section, so each intake trailer is a line here, in TNI's format
// (2026-10-08): year, make and type, its VIN and its value; a part the intake lacks is left out.
// So is a year or value the intake couldn't read ("about 25k" stays text, flagged on Check intake):
// never typed into the answer as it is.
const number = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const trailerLine = (t) => {
  const value = number(t.value);
  const parts = [[number(t.year), t.make, t.type].filter(Boolean).join(' '), t.vin ? `VIN ${t.vin}` : null, value ? moneyK(value) : null].filter(Boolean);
  return parts.length ? ['Trailer', ...parts].join(' - ') : null;
};
const disclosure = (r) => {
  const c = r.coverage;
  const lines = [];
  if (c.cargo && c.cargoLimit) {
    const goods = /general\s*freight/i.test(r.operations.whatHaul ?? '') ? 'Consumer Goods / Other Consumer Goods' : r.operations.whatHaul;
    lines.push(`Motor Truck Cargo ${moneyK(c.cargoLimit)} with ${moneyK(c.cargoDeductible ?? 1000)} Ded${goods ? ` - ${goods}` : ''}`);
  }
  const miles = radius(r);
  if (miles) lines.push(miles > 500 ? 'More than 500 miles radius of operation' : `${miles} miles radius of operation`);
  for (const t of r.trailers ?? []) { const line = trailerLine(t); if (line) lines.push(line); }
  const p = r.priorInsurance?.[0];
  if (p?.carrier && !noPriorInsurance(p)) {
    const kind = /commercial/i.test(p.type ?? '') ? 'Commercial' : /personal/i.test(p.type ?? '') ? 'Personal' : p.type;
    const carrier = p.carrier.toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
    const unavailable = /\b(?:pop|proof of prior)(?:\s+(?:insurance|document))?\s+(?:unavailable|missing|not available)\b/i.test(otherNotes(r) ?? '');
    const prefix = unavailable ? 'Prior insurance; POP document unavailable' : 'POP';
    lines.push([prefix, kind].filter(Boolean).join(' ') + ` - ${carrier}${p.limit ? ` - ${p.limit}` : ''}${p.expiration ? ` - Exp Date ${p.expiration}` : ''}${priorPolicyExpired(r, p) ? ' - EXPIRED; confirm renewal or lapse' : ''}`);
  }
  return lines.join('\n') || null;
};

// Body type as on the intake: a Van is a Cargo Van.
const bodyType = (r, a) => {
  const t = r.vehicles?.[a.vehicles ?? 0]?.type ?? null;
  return t && /^van$/i.test(t.trim()) ? 'Cargo Van' : t;
};
// Driver gender and year first licensed (TNI 2026-10-10, reversing 2026-10-09): neither is on the
// intake. Gender is TNI's standard MALE unless the agent set the driver's gender (client details or
// an accepted AI suggestion); another value there is the agent's to pick on the page.
const driverOf = (r, a) => r.drivers?.[a.drivers ?? 0] ?? null;
const genderSet = (r, a) => {
  const g = String(driverOf(r, a)?.gender ?? '').trim();
  return !g ? null : /^m(ale)?$/i.test(g) ? 'MALE' : /^f(emale)?$/i.test(g) ? 'FEMALE' : g;
};
const gender = (r, a) => {
  const g = genderSet(r, a);
  return g == null ? 'MALE' : /^(MALE|FEMALE)$/.test(g) ? g : null;
};
const genderNote = (r, a) => (gender(r, a) == null ? `The driver's gender "${genderSet(r, a)}" in client details isn't MALE or FEMALE: pick it yourself.` : null);
// The year first licensed: birth year + 17 (TNI's formula; live run 2026-10-10: a year the agent
// typed was refused and the application went back from Vehicles to Drivers). No readable date of
// birth is the agent's.
const birthYear = (r, a) => {
  const m = /^\d{1,2}\/\d{1,2}\/(\d{4})$/.exec(String(driverOf(r, a)?.dob ?? '').trim());
  return m ? Number(m[1]) : null;
};
const licenseYear = (r, a) => (birthYear(r, a) == null ? null : String(birthYear(r, a) + 17));
const licenseYearNote = (r, a) => (birthYear(r, a) == null
  ? 'The driver\'s date of birth is missing or unreadable, so the year first licensed (birth year + 17) can\'t be worked out: answer it yourself.' : null);
// Underwriting questions TNI answers No (both sections), by the field names AmWINS uses.
// The second section's vehicle, MVR and conviction questions have their own rules below.
const UNDERWRITING_NO = [
  'subsidiary to other', 'subsidiary', 'safety info', 'hazard exposure', 'other insurance', 'coverage denial',
  'past criminal activity', 'criminal activity in past ?5 ?years', 'code vo\\w*ation', 'finacial default', 'financial default',
  'finacial judgement', 'financial judgement', 'trust', 'foreign operations', 'other venture', 'own drones',
  'hire other to operate drones', 'use their auto', 'vehicle maintenance program', 'vehicle used by family',
  'recruiting method', 'covered by wc',
];

const filings = (r) => (r.operations.filingsRequired === true ? true : r.operations.filingsRequired === false ? false : null);

// Radius bands: "< 50 MILES", "51 - 100 MILES", "101- 200 MILES", "201 + MILES". Unlimited / long
// haul is the top band.
const radius = (r) => r.operations.radiusMiles ?? (isLongHaul(r.operations.radius) ? 501 : null);

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

// Vehicle Coverages: one row per vehicle (#vehicleCoveragesPanel, the same 0-based data-id as
// its vehicle's row), each with an "Exclude …" box per coverage. The boxes are found by their
// data-id; the label is the fallback, and the page misspells it (Exlude Towing & Labor, Exlucde
// Transportation Expense/ Rental Reimbursement). TNI: nothing is excluded. The intake has no
// per-vehicle (or per-coverage) answer for these six, so there is no client "not requested" to
// turn into an exclusion. "Exclude Waiver of Collision" only shows with waiver Yes (ours is No).
const VEHICLE_COVERAGES = '#vehicleCoveragesPanel';
const EXCLUSIONS = [
  ['medicalPaymentExclude', 'Medical Payments', 'medical'],
  ['uninsuredMotoristsExclude', 'Uninsured Motorists', 'uninsured'],
  ['comprehensiveDeductibleExclude', 'Comprehensive', 'comprehensive'],
  ['collisionDeductibleExclude', 'Collision', 'collision'],
  ['towingAndLaborReimbursementExclude', 'Towing & Labor', 'towing'],
  ['transportationExpenseReimbursementExclude', 'Rental Reimbursement', 'transportation|rental'],
];

const vehicleValueNote = (r, a) => {
  const v = r.vehicles?.[a.vehicles ?? 0]?.value;
  return v != null && typeof v !== 'number' ? `The intake's vehicle value "${v}" isn't a dollar amount: enter it yourself.` : null;
};

export const amwins = {
  id: 'amwins',
  name: 'AmWINS',
  hosts: [/(^|\.)amwinsadmittedplacement\.com$/],
  // Where page layouts are taken as the agent works without a fill: the application only.
  layoutUrl: /\/application\/businessauto/i,
  // Where fills run (also "Fill this page"): the start page, where the risk state is picked and the
  // application opened, and the application. Never the portal's other pages (audit 2026-10-08).
  autoFillUrl: /\/(commerciallines|application\/businessauto)/i,
  // One address for every step: layouts, fill and field-change events name the step (the visible
  // step heading) only when it is one of these headings (src/usage.js knownStep).
  layoutSteps: ['Insured Info', 'Drivers', 'Vehicles', 'Coverages', 'Underwriting'],
  // The same steps, in the application's order, for the side panel's page strip: the step shown
  // is read from its heading (a fill's or the recorder's), not the address.
  quoteSteps: ['Insured Info', 'Drivers', 'Vehicles', 'Coverages', 'Underwriting'].map((name) => ({ name, step: name })),
  // The rules below answer these sections row by row; a generic label rule never does. A row the
  // intake doesn't describe stays the agent's: on 2026-10-08 a trailer added by hand as a second
  // vehicle got the first vehicle's body type from the generic "body type" rule.
  rowSections: [DRIVER, VEHICLE, VEHICLE_COVERAGES],
  // The risk state on the start page (filled from the intake): the panel warns when the one picked
  // isn't the intake's garaging state, e.g. an agent's change (src/quote-state.js).
  quoteState: { pages: START_PAGES, key: 'riskState' },
  // No answer waits on the server (timing of the first three quotes: 0 of 294 answers sent a
  // request): fill a round of answers at a time.
  batch: true,
  // The business classes these rules were written and checked for (expediters and general freight
  // haulers), as isFreight reads them: the class or what they haul names expediting or general
  // freight (a missing class is still review mode).
  supportedClasses: [{ re: FREIGHT, whatHaul: true }],
  // Import Data right after the VIN list is filled, before the vehicle boxes, which it fills.
  actions: [
    ...[1, 2, 3].map((index) => ({ id: `addDriver${index}`, button: 'Add Driver', text: '^add driver$',
      // The previous driver's row is in and filled (any of its intake answers on the page); not
      // just its license number, which a driver can be missing and would then block every later row.
      when: (r) => r.drivers.length > index, afterAny: ['first', 'last', 'dob', 'licenseNumber'].map((f) => `drivers[${index - 1}].${f}`),
      unlessSelector: `#driversPanel > .app-rp-section[data-id="${index}"]` })),
    // Start: the Auto tile opens the risk state box; Open New Application once the state is in.
    { id: 'autoApplication', button: 'Auto', page: START_PAGES, text: '^auto$', unlessActions: ['openApplication'] },
    { id: 'openApplication', button: 'Open New Application', page: START_PAGES, text: '^open new application$', after: ['amwins.riskState'] },
    { id: 'importVins', button: 'Import Data', text: '^import data$', after: ['amwins.vinList'], immediate: true },
    // Import Data only shows a preview: this adds the vehicles (and redraws their rows).
    // Done only once the rows changed (the VIN and decoded values drawn into them, the list
    // emptied): a click the page didn't take is tried again, then left to the agent.
    { id: 'importVinRecords', button: 'Import Valid Records', text: '^import valid records$', afterActions: ['importVins'], immediate: true, verify: 'revealed' },
    // Underwriting: answers every General Information question No in one go (before the rules
    // below answer them one at a time; "other topics" is set back to Yes afterwards). Not while
    // an answer the agent gave is on the step: it reset a Yes of theirs (reproduced 2026-10-08),
    // and the rules answer the other questions anyway.
    { id: 'defaultNo', button: 'Default all answers to No', text: '^default all answers to\\W*no\\W*$', immediate: true, skipIfProtected: true },
  ],
  // Each step ends with Save & Continue (saves the draft, opens the next step) once nothing is
  // left for the agent. The declaration step never gets there: the declaration is the agent's.
  advance: { text: '^save\\s*(&|and)\\s*continue$' },
  rules: [
    // --- Start (/commerciallines) --------------------------------------------------------------
    { name: 'Risk state', label: 'select a risk state', path: 'amwins.riskState', kind: 'state', source: 'derived', value: (r) => r.garaging?.state ?? null },

    // --- Insured Info --------------------------------------------------------------------------
    // The agency's own details, effective dates and inspection contacts are left as the page has them.
    // Agency Information (#agnecyName, #contactName, #phone, #email are the agency's), website,
    // DBA and policy dates stay as the page has them.
    ...['#agnecyName', '#contactName', '#phone', '#email', '#website', '#effectiveDate', '#expirationDate', '#dba',
      '#inspectionContactEmail', '#inspectionContactMobilePhone']
      .map((selector) => ({ selector, name: `Left as the page has it (${selector.slice(1)})`, ignore: true })),
    // Contact Information: the client, name and phone only; single contact stays Yes.
    { selector: '#inspectionContactName', name: 'Contact name (the owner)', source: 'derived', value: ownerFull },
    { selector: '#inspectionContactOfficePhone', name: 'Contact phone', source: 'derived', value: (r) => digits(r.applicant.phone) },
    { selector: '#name', name: 'Named insured (company, else the owner)', source: 'derived', value: (r) => r.applicant.name || ownerFull(r) },
    { selector: '#ownerName', name: 'Owner full name', source: 'derived', value: ownerFull },
    { selector: '#ownerDob', name: 'Owner date of birth', kind: 'date', source: 'derived', value: (r) => owner(r).driver?.dob ?? null },
    { selector: '#mailingAddress', name: 'Mailing street', source: 'derived', value: street },
    { selector: '#mailingCity', path: 'garaging.city' },
    // The list has no blank entry: it starts on Alabama, which isn't an answer.
    { selector: '#mailingState', path: 'garaging.state', replace: true },
    { selector: '#mailingZip', path: 'garaging.zip' },
    { selector: '#businessPhone', name: 'Business phone', source: 'derived', value: (r) => digits(r.applicant.phone) },
    { selector: '#entityType', name: 'Entity type (from the company name)', kind: 'choice', source: 'derived', clientFact: true, value: entityType, note: entityTypeNote },
    { selector: '#yrsInBusiness', name: 'Years in business (standard when blank: New Venture)', kind: 'choice', source: yearsSource, value: yearsInBusiness },
    { selector: '#yearBusinessEstablished', name: 'Year established (standard when blank: this year)', kind: 'int', source: establishedSource, value: yearEstablished },
    { name: 'Non-profit (standard: No)', label: '^is non profit$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'Single contact (standard: Yes)', label: '^is single contact$', kind: 'bool', source: 'standard', value: () => true },
    { name: 'Garage address same as mailing (standard)', label: '^same as mailing address', kind: 'bool', source: 'standard', value: () => true },
    // The box doesn't copy the address over: the garage boxes are filled too.
    { selector: dataId('address', '#garagePanel'), name: 'Garage street', source: 'derived', value: street },
    { selector: dataId('city', '#garagePanel'), name: 'Garage city', path: 'garaging.city' },
    { selector: dataId('state', '#garagePanel'), name: 'Garage state', kind: 'state', source: 'derived', value: (r) => r.garaging?.state ?? null },
    { selector: dataId('zip', '#garagePanel'), name: 'Garage ZIP', path: 'garaging.zip' },
    { selector: '#natureOfBusiness', name: 'Nature of business (TRANSPORTATION for expediters / general freight)', kind: 'choice', source: 'derived', value: (r) => (isFreight(r) ? 'TRANSPORTATION' : null), note: freightNote('The nature of business') },
    { selector: '#retailOrServiceOperationPert', name: 'Retail / service operations % (standard: 0)', source: 'standard', value: () => '0' },
    { selector: '#classCodeAndDescription', name: 'Classification (484122 for expediters / general freight)', kind: 'search-select', source: 'derived', search: classSearch, value: classChoice, note: freightNote('The classification') },
    { selector: '#operationDescription', name: 'Description of operations (for hire, for expediters / general freight)', source: 'derived', value: operationsDescription, note: freightNote('The description of operations') },
    // Lienholders and lessors are added after the quote (TNI, 2026-10-09).
    { name: 'Additional interest (standard: No)', label: '^has additional interest$', kind: 'bool', source: 'standard', value: () => false },
    { selector: '#waiverType', name: 'Waiver type (standard: NONE)', kind: 'choice', source: 'standard', value: () => 'NONE' },
    // Filing counts: skipped (TNI).
    ...['#stateFillings', '#stateCargoFillings', '#otherFillings'].map((selector) => ({ selector, name: 'Filing count (skipped)', ignore: true })),
    // Prior insurance section only: every carrier dropdown is NO PRIOR (the proof of prior insurance goes in the disclosure).
    // AmWINS rebuilds the year panels when Years in Business changes and on the reload after
    // Save & Continue, collapses them all when there is more than one, and a year can have more
    // than one coverage row. So: every carrier dropdown in a prior-carrier coverage panel (not the hidden
    // template), in page order, visible or collapsed, up to six (live IL run: years 1 and 2 were
    // never filled and the agent set one by hand).
    ...Array.from({ length: 6 }, (_, n) => ({ selector: '#priorCarrierPanel .coveragePanel [data-id="carrierName"]', name: `Prior carrier ${n + 1} (standard: NO PRIOR)`, kind: 'choice', source: 'standard', value: () => 'NO PRIOR', hidden: true })),
    { name: 'Filings required', label: '^filling required$', kind: 'bool', source: 'derived', value: filings },
    { selector: '#hasDotNumber', name: 'Has a DOT number', kind: 'bool', source: 'derived', value: (r) => !!r.applicant.dot },
    { selector: '#hasMcNumber', name: 'Has an MC number', kind: 'bool', source: 'derived', value: (r) => !!r.applicant.mc },
    { selector: '#noNumber', name: 'No DOT / MC number', kind: 'bool', source: 'derived', value: (r) => !r.applicant.dot && !r.applicant.mc },
    { selector: '#dotNumber', name: 'DOT number', source: 'derived', value: (r) => digits(r.applicant.dot) },
    { selector: '#mcNumber', name: 'MC number', source: 'derived', value: (r) => digits(r.applicant.mc) },
    // Shown with Filing required Yes.
    { selector: '#howLongFederalOperatingAuthorityActive', name: 'Federal authority active for (years under own authority)', kind: 'choice', source: 'derived', value: authorityAge },
    { name: 'Federal BMC-91', label: '^federal bmc91$', kind: 'bool', source: 'derived', value: federalLiability },
    { name: 'Federal liability MCS-90', label: '^federal liability mcs90$', kind: 'bool', source: 'derived', value: federalLiability },
    { name: 'Federal cargo BMC-32', label: '^federal cargo bmc32$', kind: 'bool', source: 'derived', value: federalCargo },
    // The client's insurance history the intake doesn't give. TNI's standards (2026-10-19, after a
    // live run; may change later): 1 TO 2 YEARS with the current carrier and no claim-free loss
    // runs. The current-carrier question is only asked of clients with a DOT number. Valued loss
    // runs stay the agent's.
    { selector: '#howLongWithCurrentCarrier', name: 'How long with the current carrier (standard: 1 TO 2 YEARS)', kind: 'choice', source: 'standard', ignore: (r) => !r.applicant.dot, value: () => '1 TO 2 YEARS' },
    { name: 'Claim-free loss runs (standard: No)', label: '^can provide claim free loss run$', kind: 'bool', source: 'standard', value: () => false },
    { label: '^valued loss runs$', kind: 'bool', ...fact('Valued loss runs', 'Whether valued loss runs can be provided isn\'t on the intake: answer it yourself.') },
    // Preserve the intake's explicit claims answer; unknown history stays with the agent.
    // Yes opens the required Loss History.
    { name: 'Any prior loss', label: '^any prior loss$', kind: 'bool', source: 'derived', clientFact: true,
      value: (r) => typeof r.claims?.hasClaims === 'boolean' ? r.claims.hasClaims : null,
      note: (r) => typeof r.claims?.hasClaims === 'boolean' ? null : 'The intake doesn\'t answer the claims / violations question: answer prior loss yourself.' },

    // --- Drivers ---------------------------------------------------------------------------------
    // Names and license number first: they retitle the driver panel; gender, marital status and
    // license year after them.
    { selector: dataId('firstName', DRIVER), path: 'drivers[].first' },
    { selector: dataId('middleName', DRIVER), name: 'Middle name (only when the intake has one)', path: 'drivers[].middle', ignore: (r, a) => !r.drivers?.[a.drivers ?? 0]?.middle },
    { selector: dataId('lastName', DRIVER), path: 'drivers[].last' },
    { selector: dataId('dateOfBirth', DRIVER), path: 'drivers[].dob' },
    { selector: dataId('licenseNumber', DRIVER), path: 'drivers[].licenseNumber' },
    { selector: dataId('licenseState', DRIVER), path: 'drivers[].licenseState' },
    // Gender and the year first licensed aren't on the intake: TNI's standards (2026-10-10; the
    // agent's from 2026-10-09): MALE unless the agent set the driver's gender, and birth year + 17
    // (none without a readable date of birth). Marital status from the intake; none there is the
    // agent's (until 2026-10-09 MARRIED, flagged to confirm).
    { selector: dataId('gender', DRIVER), name: 'Gender (standard: MALE unless set in client details)', kind: 'choice',
      // A value set but not MALE or FEMALE is the agent's to pick, never the AI's (a fact).
      source: (r, a) => (genderSet(r, a) == null ? 'standard' : gender(r, a) == null ? 'fact' : 'derived'), value: gender, note: genderNote },
    { selector: dataId('martialStatus', DRIVER), name: 'Marital status', kind: 'choice', path: 'drivers[].maritalStatus', clientFact: true },
    { selector: dataId('licenseYear', DRIVER), name: 'Year licensed (standard: birth year + 17)',
      source: (r, a) => (birthYear(r, a) == null ? 'fact' : 'standard'), value: licenseYear, note: licenseYearNote },

    // --- Vehicles --------------------------------------------------------------------------------
    { name: 'File upload (not used)', label: '^select files?', ignore: true },
    { selector: '#vehLookupVin', path: 'amwins.vinList', name: 'VINs to look up (one per line)', source: 'derived', value: (r) => r.vehicles.map((v) => v.vin).filter(Boolean).join('\n') || null },
    { selector: dataId('locationNumber', VEHICLE), name: 'Vehicle location (standard: the first, the insured)', kind: 'first-option', source: 'standard', value: () => 'first option' },
    // VIN, year, make, model come from Import Data (its wording wins). Each row below is found by
    // its VIN (the witness set at the end of this list), so a vehicle the import didn't add has
    // no row and stays the agent's: nothing is typed into a blank row.
    { selector: dataId('vin', VEHICLE), path: 'vehicles[].vin', trustPage: true },
    { selector: dataId('year', VEHICLE), path: 'vehicles[].year', trustPage: true },
    { selector: dataId('make', VEHICLE), path: 'vehicles[].make', trustPage: true },
    { selector: dataId('model', VEHICLE), path: 'vehicles[].model', trustPage: true },
    // The VIN decoder writes its own body type; the intake's wins (Box Truck, Cargo Van).
    { selector: dataId('bodyType', VEHICLE), name: 'Body type (as on the intake)', source: 'derived', value: bodyType, replace: true },
    // From the VIN decoder; required, so flagged only when it stays empty.
    { selector: dataId('grossVehicleWeight', VEHICLE), name: 'GVW (from Import Data)', ignore: true, emptyNote: 'GVW comes from Import Data / the VIN; it stayed empty, so enter it from the registration.' },
    { selector: '#marketValue', path: 'vehicles[].value', name: 'Vehicle value', note: vehicleValueNote },
    { selector: dataId('usageType', VEHICLE), name: 'Usage type (For hire, for expediters / general freight)', kind: 'choice', source: 'derived', value: (r) => (isFreight(r) ? 'FOR HIRE' : null), note: freightNote('The usage type') },
    { selector: dataId('radius', VEHICLE), name: 'Radius', kind: 'int', source: 'derived', value: radius },
    { name: 'Permanently attached equipment (standard: No unless the intake gives a value)', label: '^permanently attached equipment', kind: 'bool', source: equipmentSource, clientFact: true, value: equipment, note: equipmentNote },

    // --- Coverages -------------------------------------------------------------------------------
    { name: 'CSL liability limit', label: '^csl liability limit$', path: 'coverage.autoLiabLimit' },
    { name: 'Uninsured motorists (standard: Yes)', label: '^uninsured motorists$', kind: 'bool', source: 'standard', value: () => true },
    { name: 'Rental reimbursement (standard: $40/day, $1,200)', label: 'transportation expense|rental reimbursement', kind: 'choice', source: 'standard', value: () => '$40 day / $1,200 total' },
    { selector: '#uninsuredMotoristsLimit', name: 'UM limit (standard: $100K)', kind: 'choice', source: 'standard', value: () => '$100K' },
    { selector: '#medicalPayment', name: 'Medical payments (standard: $5,000)', kind: 'choice', source: 'standard', value: () => '$5,000' },
    { selector: '#comprehensiveDeductible', name: 'Comprehensive deductible (standard: $1,000)', kind: 'choice', source: 'standard', value: () => '$1,000' },
    { selector: '#collisionDeductible', name: 'Collision deductible (standard: $1,000)', kind: 'choice', source: 'standard', value: () => '$1,000' },
    { name: 'Waiver of collision (standard: No)', label: '^has waiver of collision$', kind: 'bool', source: 'standard', value: () => false },
    { selector: '#towingAndLaborReimbursement', name: 'Towing and labor (standard: $75)', kind: 'choice', source: 'standard', value: () => '$75' },
    // PIP: No whenever Medical Payments is offered, which on AmWINS is always (the Coverages step
    // has #medicalPayment, $5,000 above). The page pre-selects Yes, so ours replaces it. The limit
    // box only shows with Yes.
    { name: 'Personal Injury Protection (standard: No, Medical Payments is offered)', label: '^personal injury protection$', kind: 'bool', source: 'standard', value: () => false, replace: true },
    { selector: '#personalInjuryProtectionLimit', name: 'Personal Injury Protection limit (only with PIP Yes)', ignore: true },
    // Liability auto symbol: 6 only.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ selector: `#autoSymbol${n}`, name: `Auto symbol ${n}${n === 6 ? ' (standard: 6)' : ' (standard: unticked)'}`, group: 'Liability coverage auto symbol', kind: 'bool', source: 'standard', value: () => n === 6 })),
    // Nothing is excluded, on every vehicle's row: one rule per box, repeated per vehicle below.
    ...EXCLUSIONS.map(([id, title, topic]) => ({ selector: dataId(id, VEHICLE_COVERAGES), name: `Exclude ${title} (standard: No, not excluded)`,
      label: `^ex\\w*de\\b.*(${topic})`, not: 'waiver', kind: 'bool', source: 'standard', value: () => false })),

    // --- Underwriting questions --------------------------------------------------------------------
    // TNI answers this section No (2026-10-09), also when the intake reports claims or leased
    // vehicles; hazardous material is the intake's answer.
    { name: 'Vehicles not owned (standard: No)', label: '^any vehicle not owned$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'Vehicles leased to others (standard: No)', label: '^vehicle leased$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'MVR verification (standard: No)', label: '^mvr verification$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'Owned unscheduled vehicles (standard: No)', label: '^owned unscheduled vehicle$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'Convictions / moving violations (standard: No)', label: '^convictions moving violations$', kind: 'bool', source: 'standard', value: () => false },
    { name: 'Hazardous material', label: '^transporting hazardous material$', kind: 'bool', path: 'operations.hazmat' },
    ...UNDERWRITING_NO.map((q) => ({ name: `Underwriting: ${q.replace(/[?\\]/g, '')} (standard: No)`, label: `^${q}$`, kind: 'bool', source: 'standard', value: () => false })),
    // Yes again after "Default all answers to No".
    { name: 'Other topics to disclose (standard: Yes)', label: '^other topic$', kind: 'bool', source: 'standard', value: () => true, replace: true },
    { name: 'Disclosure details (from the intake)', label: '^disclosure details$', source: 'derived', value: disclosure },
    // The declaration is the agent's to make.
    { selector: '#accept', name: 'Declaration', kind: 'bool', source: 'attestation', note: 'The declaration is yours to confirm; never ticked. Then Submit (yours too).' },
  ].map((rule) => {
    // AmWINS shows several repeater rows on one page. Give every row its own values;
    // the active-driver picker is for carriers that show one driver page at a time.
    let panel = rule.selector?.startsWith(DRIVER) ? DRIVER : rule.selector?.startsWith(VEHICLE) || rule.selector === '#marketValue' ? VEHICLE
      : rule.selector?.startsWith(VEHICLE_COVERAGES) ? VEHICLE_COVERAGES : null;
    if (rule.label === '^permanently attached equipment') panel = VEHICLE;
    if (!panel) return rule;
    const list = panel === DRIVER ? 'drivers' : 'vehicles';
    const selector = rule.selector === '#marketValue' ? `${VEHICLE} [data-id="costNew"]`
      : rule.label === '^permanently attached equipment' ? `${VEHICLE} [data-id="permanentlyAttachedEquipment"] input[type="radio"]` : rule.selector;
    // A vehicle's row is the one showing its VIN (the witness), whatever its position: Import
    // Valid Records draws the rows in its own order, and a VIN it rejected has no row (that
    // vehicle's answers stay the agent's). Until the import lands the rows show no VIN, so
    // nothing is typed into a row before it. Drivers and the coverage rows have no VIN: theirs
    // are still the row at the unit's position.
    if (panel === VEHICLE) {
      return { ...rule, repeat: list, witness: { selector: '[data-id="vin"]', path: 'vehicles[].vin' },
        repeatSelector: (r) => (r[list].length > 1 ? selector.replace(panel, `${panel} .app-rp-section`) : selector) };
    }
    return { ...rule, repeat: list, repeatSelector: (r, a) => r[list].length > 1
      ? selector.replace(panel, `${panel} > .app-rp-section[data-id="${a[list]}"]`) : rule.selector || selector };
  }),
};
