// Generic "what does this label mean" rules, used on any rater page when a carrier has no exact
// mapping for a field yet. `label` and `not` are regex sources tested against the field's label
// after it is lowercased and stripped to letters, digits and single spaces ("Driver's License #"
// becomes "drivers license"). The first rule that matches a field claims it, so order matters:
// specific rules come before general ones.

export const GENERIC_RULES = [
  // Drivers
  { path: 'drivers[].licenseState', label: '(licen[cs]e|dl) (issu(ed|ing) )?state|state (of|issu\\w*) (licen[cs]e|dl)|licensed in|state licensed' },
  { path: 'drivers[].cdlYear', label: 'cdl.*(year|since|date|obtained|issued)|years? (of |with )?cdl|year.*cdl' },
  { path: 'drivers[].licenseNumber', label: '(drivers? )?licen[cs]e (number|no|num|id)|\\bdl (number|no|num)\\b|^dl$|^drivers? licen[cs]e$', not: 'state|plate|year|date|status|type|class|cdl|business|agent|agency|producer' },
  { path: 'drivers[].cdl', label: '\\bcdl\\b|commercial drivers? licen[cs]e', not: 'year|date|since|number|experience|state|class' },
  { path: 'drivers[].first', label: 'first name|given name|^first$', not: 'business|company|agent|contact|producer' },
  { path: 'drivers[].middle', label: 'middle (name|initial)|^mi$|^middle$' },
  { path: 'drivers[].last', label: 'last name|surname|family name|^last$', not: 'business|company|agent|contact|producer' },
  { path: 'drivers[].dob', label: 'birth|\\bdob\\b' },
  { path: 'drivers[].maritalStatus', label: 'marital' },

  // Vehicles
  { path: 'vehicles[].vin', label: '\\bvin\\b|vehicle identification', not: 'trailer' },
  { path: 'vehicles[].year', label: '^(vehicle |model |truck )?year$|^year of (the )?(vehicle|truck)', not: 'trailer' },
  { path: 'vehicles[].make', label: '^(vehicle |truck )?make$', not: 'trailer' },
  { path: 'vehicles[].model', label: '^(vehicle |truck )?model$', not: 'trailer|year' },
  { path: 'vehicles[].value', label: 'stated (value|amount)|(vehicle|truck|unit) value|actual cash value|cost new|^value$', not: 'trailer|cargo|equipment' },
  { path: 'vehicles[].type', label: '(vehicle|body|truck) type|type of (vehicle|truck)', not: 'trailer' },

  // Business
  { path: 'applicant.dot', label: '\\b(us ?)?dot( number| no| num)?\\b', not: 'date|state' },
  { path: 'applicant.mc', label: '\\bmc( number| no| num| docket)?\\b|motor carrier (number|no)|\\bmx\\b|docket' },
  { path: 'applicant.fein', label: '\\bfein\\b|\\bein\\b|federal (tax|employer)|tax id|\\btin\\b' },
  { path: 'applicant.name', label: '(business|company|legal|named insured|insured|applicant) name|^name of (the )?(business|company|insured)|^named insured$', not: 'first|last|middle|contact|dba|agent|producer|agency' },
  { path: 'applicant.yearsInBusiness', label: 'years? in business|years? (in )?operation|how long.*business' },
  { path: 'applicant.yearEstablished', label: '(year|date) (business )?(established|started|founded|formed)|year.*(business|company) (start|began)' },
  { path: 'applicant.phone', label: 'phone|telephone|mobile|cell', not: 'ext|extension|type|agent|producer|agency' },
  { path: 'applicant.email', label: 'e ?mail', not: 'agent|producer|agency|confirm' },

  // Garaging address
  { path: 'garaging.zip', label: '\\bzip|postal' },
  { path: 'garaging.unit', label: 'address (line )?2|\\bapt\\b|apartment|suite|\\bunit (number|no)\\b|^unit$' },
  { path: 'garaging.street', label: '(street|garaging|mailing|physical|business)? ?address( line)?( 1)?$|^street', not: 'e ?mail|web|\\bip\\b|2|city|state|zip' },
  { path: 'garaging.city', label: '\\bcity\\b' },
  { path: 'garaging.state', label: '^(garaging |mailing |physical |business )?state$|state of (garaging|domicile)' },

  // Operations
  { path: 'operations.radius', label: 'radius|miles from (garag|home)' },
  { path: 'operations.eldBrand', label: '(eld|electronic log\\w*) (brand|provider|vendor|company|name)' },
  { path: 'operations.usesEld', label: '\\beld\\b|electronic log', not: 'brand|provider|vendor|name|company' },
  { path: 'operations.needSr22', label: 'sr ?22' },
  { path: 'operations.hazPlacard', label: 'placard' },
  { path: 'operations.hazmat', label: 'haz ?mat|hazardous (material|cargo)' },
  { path: 'operations.filingsRequired', label: 'filings?', not: 'which|type|list|number' },
  { path: 'operations.whatHaul', label: 'commodit|cargo (type|hauled|description)|what .*haul|type of (cargo|freight)' },
  { path: 'operations.businessClass', label: '(business|operations?) (class|type|classification)|type of (business|operation)' },
  { path: 'operations.personalUse', label: 'personal use' },

  // Coverage
  { path: 'coverage.cargoDeductible', label: 'cargo deduct' },
  { path: 'coverage.cargoLimit', label: 'cargo (limit|coverage limit|amount)|motor truck cargo', not: 'deduct' },
  { path: 'coverage.glLimit', label: 'general liability.*limit|\\bgl limit' },
  { path: 'coverage.autoLiabLimit', label: '(auto |bodily injury |combined single |csl )?liability limit|^bi limit|combined single limit', not: 'general|cargo' },

  // Current insurance
  { path: 'priorInsurance[0].carrier', label: '(prior|current|previous) (carrier|insurer|insurance (company|carrier))' },
  { path: 'priorInsurance[0].expiration', label: '(prior|current|previous).*expir|policy expiration' },
];
