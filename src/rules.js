// Generic "what does this label mean" rules, used on any rater page when a carrier has no exact
// mapping for a field yet. `label` and `not` are regex sources tested against the field's label
// after it is lowercased and stripped to letters, digits and single spaces ("Driver's License #"
// becomes "drivers license"). The first rule that matches a field claims it, so order matters:
// specific rules come before general ones.

import { noPriorInsurance } from './util.js';

const noPriorNote = (r) => (noPriorInsurance(r.priorInsurance?.[0])
  ? `The intake's current insurance says "${r.priorInsurance[0].carrier}": no prior insurance. Answer it yourself.` : null);

export const GENERIC_RULES = [
  // Drivers
  { concept: 'driver.license-state', path: 'drivers[].licenseState', label: '(licen[cs]e|dl) (issu(ed|ing) )?state|state (of|issu\\w*) (licen[cs]e|dl)|licensed in|state licensed' },
  { concept: 'driver.cdl-year', path: 'drivers[].cdlYear', label: 'cdl.*(year|since|date|obtained|issued)|years? (of |with )?cdl|year.*cdl' },
  { concept: 'driver.license-number', path: 'drivers[].licenseNumber', label: '(drivers? )?licen[cs]e (number|no|num|id)|\\bdl (number|no|num)\\b|^dl$|^drivers? licen[cs]e$', not: 'state|plate|year|date|status|type|class|cdl|business|agent|agency|producer' },
  { concept: 'driver.cdl', path: 'drivers[].cdl', label: '\\bcdl\\b|commercial drivers? licen[cs]e', not: 'year|date|since|number|experience|state|class' },
  { concept: 'driver.name', path: 'drivers[].first', label: 'first name|given name|^first$', not: 'business|company|agent|contact|producer' },
  { concept: 'driver.name', path: 'drivers[].middle', label: 'middle (name|initial)|^mi$|^middle$' },
  { concept: 'driver.name', path: 'drivers[].last', label: 'last name|surname|family name|^last$', not: 'business|company|agent|contact|producer' },
  { concept: 'driver.dob', path: 'drivers[].dob', label: 'birth|\\bdob\\b' },
  { concept: 'driver.marital-status', path: 'drivers[].maritalStatus', label: 'marital' },

  // Vehicles
  { concept: 'vehicle.vin', path: 'vehicles[].vin', label: '\\bvin\\b|vehicle identification', not: 'trailer' },
  { concept: 'vehicle.year', path: 'vehicles[].year', label: '^(vehicle |model |truck )?year$|^year of (the )?(vehicle|truck)', not: 'trailer' },
  { concept: 'vehicle.make', path: 'vehicles[].make', label: '^(vehicle |truck )?make$', not: 'trailer' },
  { concept: 'vehicle.model', path: 'vehicles[].model', label: '^(vehicle |truck )?model$', not: 'trailer|year' },
  { concept: 'vehicle.value', path: 'vehicles[].value', label: 'stated (value|amount)|(vehicle|truck|unit) value|actual cash value|cost new|^value$', not: 'trailer|cargo|equipment' },
  { concept: 'vehicle.type', path: 'vehicles[].type', label: '(vehicle|body|truck) type|type of (vehicle|truck)', not: 'trailer' },

  // Business
  { concept: 'business.usdot', path: 'applicant.dot', label: '\\b(us ?)?dot( number| no| num)?\\b', not: 'date|state' },
  { concept: 'business.mc', path: 'applicant.mc', label: '\\bmc( number| no| num| docket)?\\b|motor carrier (number|no)|\\bmx\\b|docket' },
  { concept: 'business.ein', path: 'applicant.fein', label: '\\bfein\\b|\\bein\\b|federal (tax|employer)|tax id|\\btin\\b' },
  { concept: 'business.name', path: 'applicant.name', label: '(business|company|legal|named insured|insured|applicant) name|^name of (the )?(business|company|insured)|^named insured$', not: 'first|last|middle|contact|dba|agent|producer|agency' },
  { concept: 'business.years', path: 'applicant.yearsInBusiness', label: 'years? in business|years? (in )?operation|how long.*business' },
  { concept: 'business.years', path: 'applicant.yearEstablished', label: '(year|date) (business )?(established|started|founded|formed)|year.*(business|company) (start|began)' },
  { concept: 'business.contact', path: 'applicant.phone', label: 'phone|telephone|mobile|cell', not: 'ext|extension|type|agent|producer|agency' },
  { concept: 'business.contact', path: 'applicant.email', label: 'e ?mail', not: 'agent|producer|agency|confirm' },

  // Garaging address
  { concept: 'business.address', path: 'garaging.zip', label: '\\bzip|postal' },
  { concept: 'business.address', path: 'garaging.unit', label: 'address (line )?2|\\bapt\\b|apartment|suite|\\bunit (number|no)\\b|^unit$' },
  { concept: 'business.address', path: 'garaging.street', label: '(street|garaging|mailing|physical|business)? ?address( line)?( 1)?$|^street', not: 'e ?mail|web|\\bip\\b|2|city|state|zip' },
  { concept: 'business.address', path: 'garaging.city', label: '\\bcity\\b' },
  { concept: 'business.address', path: 'garaging.state', label: '^(garaging |mailing |physical |business )?state$|state of (garaging|domicile)' },

  // Operations
  { concept: 'operations.radius', path: 'operations.radius', label: 'radius|miles from (garag|home)' },
  { concept: 'operations.eld', path: 'operations.eldBrand', label: '(eld|electronic log\\w*) (brand|provider|vendor|company|name)' },
  { concept: 'operations.eld', path: 'operations.usesEld', label: '\\beld\\b|electronic log', not: 'brand|provider|vendor|name|company' },
  { concept: 'driver.sr22', path: 'operations.needSr22', label: 'sr ?22' },
  { concept: 'operations.hazmat-placard', path: 'operations.hazPlacard', label: 'placard' },
  { concept: 'operations.hazmat', path: 'operations.hazmat', label: 'haz ?mat|hazardous (material|cargo)' },
  { concept: 'filings.required', path: 'operations.filingsRequired', label: 'filings?', not: 'which|type|list|number' },
  { concept: 'cargo.commodity', path: 'operations.whatHaul', label: 'commodit|cargo (type|hauled|description)|what .*haul|type of (cargo|freight)' },
  { concept: 'business.class', path: 'operations.businessClass', label: '(business|operations?) (class|type|classification)|type of (business|operation)' },
  { concept: 'operations.personal-use', path: 'operations.personalUse', label: 'personal use' },

  // Coverage
  { concept: 'coverage.cargo', path: 'coverage.cargoDeductible', label: 'cargo deduct' },
  { concept: 'coverage.cargo', path: 'coverage.cargoLimit', label: 'cargo (limit|coverage limit|amount)|motor truck cargo', not: 'deduct' },
  { concept: 'coverage.gl', path: 'coverage.glLimit', label: 'general liability.*limit|\\bgl limit' },
  { concept: 'coverage.liability', path: 'coverage.autoLiabLimit', label: '(auto |bodily injury |combined single |csl )?liability limit|^bi limit|combined single limit', not: 'general|cargo' },

  // Current insurance. "NO POP" and the like is no prior: nothing is typed, and the question stays
  // the agent's (how a rater says "no prior" differs).
  { concept: 'prior.carrier', path: 'priorInsurance[0].carrier', label: '(prior|current|previous) (carrier|insurer|insurance (company|carrier))', note: noPriorNote },
  { concept: 'prior.expiration', path: 'priorInsurance[0].expiration', label: '(prior|current|previous).*expir|policy expiration', note: noPriorNote },
];
