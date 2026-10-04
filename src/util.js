export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Paths look like "applicant.dot" or "drivers[0].first".
function splitPath(path) {
  return path.split('.').flatMap((part) => {
    const m = part.match(/^(\w+)\[(\d+)\]$/);
    return m ? [m[1], Number(m[2])] : [part];
  });
}

export function get(obj, path) {
  let cur = obj;
  for (const key of splitPath(path)) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function set(obj, path, value) {
  const keys = splitPath(path);
  let cur = obj;
  keys.slice(0, -1).forEach((key, i) => {
    if (cur[key] == null) cur[key] = typeof keys[i + 1] === 'number' ? [] : {};
    cur = cur[key];
  });
  cur[keys.at(-1)] = value;
}

// "drivers[].first" -> "drivers"
export function listOf(path) {
  const m = path.match(/^(\w+)\[\]/);
  return m ? m[1] : null;
}

// Compare calendar dates using the application date, so an archived intake stays reproducible.
// An absent/invalid date does not establish that a policy expired.
export function priorPolicyExpired(record, policy = record.priorInsurance?.[0]) {
  const parse = (value) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? '');
    if (!m) return null;
    const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2] ? +d : null;
  };
  const expiry = parse(policy?.expiration);
  const now = new Date();
  const reference = parse(record.applicant?.applicationDate) ?? Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return expiry != null && expiry < reference;
}

// A person's name as lowercase words without accents ("Campelo Kraychete" -> ["campelo", "kraychete"]).
export function nameWords(name) {
  return String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [];
}

// The intake's owner name is this driver: the same words across the name boxes, the same
// one-word surname, or the owner's last word is one of the driver's last-name words (two-word
// surnames: "CAMPELO KRAYCHETE") and the owner's first name is one of the driver's given names
// (owner "Alice Smith" is not driver "Bob Jones Smith").
export function ownerIsDriver(ownerName, d) {
  const owner = nameWords(ownerName);
  if (!owner.length || !d) return false;
  const driver = nameWords(`${d.first ?? ''} ${d.middle ?? ''} ${d.last ?? ''}`);
  if (owner.length === driver.length && [...owner].sort().join(' ') === [...driver].sort().join(' ')) return true;
  const last = nameWords(d.last);
  if (last.length === 1 && last[0] === owner.at(-1)) return true;
  return last.includes(owner.at(-1)) && nameWords(`${d.first ?? ''} ${d.middle ?? ''}`).includes(owner[0]);
}
