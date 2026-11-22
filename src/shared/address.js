// @ts-check
// Splits a one-line US address, as an intake box holds it ("123 Main St, Knoxville, TN 37901").
// Shared by every product (src/shared/parse.js says what that means).

import { STATES } from '../states.js';
import { clean } from './parse.js';

// Street types that also start place names ("Glen Allen", "Bend", "Point Pleasant"): one only ends the
// street when no stronger type follows it.
const PLACE_SUFFIX = new Set(['ridge', 'rdg', 'point', 'pt', 'crossing', 'bend', 'pass', 'path', 'walk', 'crescent', 'cres', 'hollow', 'holw',
  'landing', 'lndg', 'trace', 'trce', 'hill', 'hills', 'glen', 'park']);
const STREET_SUFFIX = new Set(['st', 'street', 'ave', 'av', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'cir', 'ci', 'circle', 'blvd', 'boulevard', 'way', 'pl', 'place', 'ter', 'terrace', 'pkwy', 'parkway', 'hwy', 'highway', 'trl', 'trail', 'loop', 'sq', 'pike', 'tpke', 'cv', 'cove', 'xing', 'plz', 'aly', 'row', 'run',
  // W45-03 (an agent's VA address lost its city): street types the split didn't know.
  ...PLACE_SUFFIX, 'ext', 'route', 'rte', 'rt']);
const DIRECTIONAL = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const UNIT_WORD = /^(apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr|#)\.?$/i;
// The states written out ("North Carolina"), longest first, as one alternation, built on first use.
let stateNames = null;
const statesWrittenOut = () => {
  if (!stateNames) {
    const names = Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]);
    stateNames = { names, re: names.map(([name]) => name).sort((a, b) => b.length - a.length).map((name) => name.replace(/\s+/g, '\\s+')).join('|') };
  }
  return stateNames;
};
const ZIP = String.raw`(\d{5})(?:-?(\d{4}))?(?![0-9])`;
const zipOf = (five, four) => (four ? `${five}-${four}` : five);

// Where the state and ZIP sit at the end of an address, tried in turn (W45-03): `rest` is what comes
// before them, `sure` false for the shapes the agent should confirm, `junk` true when letters after
// the ZIP were dropped (a county). A city run together with its state ("HENRICOVA 23228") is
// `joined`: nothing is taken from it (TNI, 2026-11-03: the agent's to fix).
function stateAndZip(body) {
  const code = (c) => (STATES[c.toUpperCase()] ? c.toUpperCase() : null);
  // "… KY 41011", "… KY, 41011", "… KY41011", and letters after the ZIP.
  let m = body.match(new RegExp(String.raw`^(.*?)[,\s]+([A-Za-z]{2})\.?[,\s]*${ZIP}(\s*[A-Za-z].*)?$`));
  if (m && code(m[2])) return { rest: m[1], state: code(m[2]), zip: zipOf(m[3], m[4]), sure: true, junk: !!m[5] };
  // "… 41011 KY": the ZIP first.
  m = body.match(new RegExp(String.raw`^(.*?)[,\s]+${ZIP}[,\s]+([A-Za-z]{2})\.?$`));
  if (m && code(m[4])) return { rest: m[1], state: code(m[4]), zip: zipOf(m[2], m[3]), sure: false, junk: false };
  // "… Kentucky 41011", "… North Carolina", with or without the ZIP.
  const { names, re } = statesWrittenOut();
  m = body.match(new RegExp(String.raw`^(.*?)[,\s]+(${re})\.?(?:[,\s]*${ZIP}(\s*[A-Za-z].*)?)?$`, 'i'));
  if (m && m[1]) {
    const name = m[2].toLowerCase().replace(/\s+/g, ' ');
    return { rest: m[1], state: names.find(([n]) => n === name)[1], zip: m[3] ? zipOf(m[3], m[4]) : null, sure: false, junk: !!m[5] };
  }
  // "… Covington, KY": no ZIP. NE is a street's direction more often than Nebraska ("12 Elm St NE",
  // "12 Elm St, NE"); only a comma-separated street, city and NE ("…, Omaha, NE") is the state.
  m = body.match(/^(.*?)([,\s]+)([A-Za-z]{2})\.?$/);
  const nebraska = (m2) => {
    // "12 Elm St, Apt 4, NE": a unit isn't a city.
    const parts = m2[1].split(',').map((p) => p.trim()).filter((p) => p && !UNIT_WORD.test(p.split(/\s+/)[0]) && !p.startsWith('#'));
    // "4500, Oak Ridge Rd, NE": a house number written apart is still the street, not a city.
    if (/^\d+[A-Za-z]?$/.test(parts[0] ?? '')) parts.shift();
    return m2[2].includes(',') && parts.length > 1;
  };
  if (m && code(m[3]) && (m[3].toUpperCase() !== 'NE' || nebraska(m))) return { rest: m[1], state: code(m[3]), zip: null, sure: false, junk: false };
  // "… HENRICOVA 23228": no state of its own, but the word before the ZIP ends in a state's code.
  m = body.match(new RegExp(String.raw`^.*?[,\s]+[A-Za-z]{3,}([A-Za-z]{2})\.?[,\s]*${ZIP}`));
  if (m && code(m[1])) return { joined: true };
  return null;
}

// Splits a one-line US address. `confident` is false when there were no commas and where the
// street ends is a guess (a place word, or a city that holds a street type, a direction or a
// digit; TNI, 2026-11-19), when trailing ZIP junk was dropped, or when the state was written out,
// came after the ZIP or had no ZIP (W45-03). A directional glued to
// the city ("SWCARTERSVILLE") stays in the city for the agent to confirm: without a list of cities
// it can't be told from NEWARK or SEATTLE (TNI, 2026-10-27). A city run together with its state
// ("HENRICOVA") is `joined`, and nothing is split: the agent's (TNI, 2026-11-03).
export function parseAddress(raw) {
  const s = clean(raw);
  if (s == null) return null;
  const out = { street: s, unit: null, city: null, state: null, zip: null, confident: false };
  // What follows the ZIP: a comma or period ("…, MN 55447,"), the country ("…, MN 55447, USA"), or
  // leftover text the form glued on (a county: "… 30120-5877BARTOW"; TNI, 2026-10-27).
  const body = s.replace(/[\s,.;]+(?:(?:USA|U\.S\.A\.?|US|U\.S\.?|United States(?: of America)?)[\s,.;]*)?$/i, '');
  const end = stateAndZip(body);
  if (!end) return out;
  if (end.joined) return { ...out, joined: true };
  out.state = end.state;
  out.zip = end.zip;
  const repaired = end.junk || !end.sure;
  const rest = end.rest.replace(/,\s*$/, '');
  let streetPart = rest;
  if (rest.includes(',')) {
    const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
    // "4500, Oak Ridge Rd, …": a house number written apart from its street.
    if (parts.length > 2 && /^\d+[A-Za-z]?$/.test(parts[0])) parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
    out.city = parts.pop() ?? null;
    streetPart = parts.join(', ');
    out.confident = parts.length > 0;
  } else {
    const t = rest.split(/\s+/);
    const word = (i) => String(t[i] ?? '').toLowerCase().replace(/\.$/, '');
    const suffix = (i) => STREET_SUFFIX.has(word(i));
    const place = (i) => PLACE_SUFFIX.has(word(i));
    const saint = (i) => /^ste?\.?$/i.test(t[i] ?? '');
    let cut = -1;
    let byPlace = false;
    for (let i = 1; i < t.length - 1; i++) {
      if (UNIT_WORD.test(t[i])) { cut = i + 1; byPlace = false; break; }
      if (/^#\w+/.test(t[i])) { cut = i; byPlace = false; break; }
      // The street's type, unless another follows it ("Court St", "Oak Ridge Rd"); "Main St St
      // Louis" ends at the first St, and "Main St Glen Allen" at St, as a place word can't outrank it.
      const outranked = suffix(i + 1) && (place(i) || !place(i + 1)) && !(saint(i) && saint(i + 1));
      if (cut < 0 && suffix(i) && !outranked) {
        let end = i;
        // A numbered route or county road: "Hwy 60", "County Rd 12".
        if (/^\d+[A-Za-z]?$/.test(t[end + 1] ?? '')) end++;
        cut = DIRECTIONAL.has(t[end + 1]?.toLowerCase()) ? end + 1 : end;
        // A word direction after the street type may start the city ("St North Little Rock").
        byPlace = place(i) || (cut > end && t[cut].length > 2);
      }
    }
    if (cut >= 0 && cut < t.length - 1) {
      streetPart = t.slice(0, cut + 1).join(' ');
      out.city = t.slice(cut + 1).join(' ');
      // As sure as a split with commas (TNI, 2026-11-19, audit of that day: the agent confirmed
      // 136 guessed splits and changed 5 cities): the street ends at a street type (or a unit),
      // not a place word ("Oak Ridge Henrico"), and the city is up to three words with no street
      // type, place word, direction or digit in it. "Main St Glen Allen" or "Elm St Bend" could
      // end the street at either word, and "SWCARTERSVILLE" may hold a direction glued on: those
      // stay the agent's to confirm. A city starting with St or Ste ("St Louis") is a saint.
      const city = t.slice(cut + 1);
      const sure = city.length <= 3 && !/^(ne|nw|se|sw)/i.test(city[0])
        && city.every((w, k) => !/\d/.test(w) && !DIRECTIONAL.has(w.toLowerCase().replace(/\.$/, ''))
          && (!STREET_SUFFIX.has(w.toLowerCase().replace(/\.$/, '')) || (k === 0 && city.length > 1 && saint(cut + 1))));
      out.confident = !byPlace && sure;
    }
  }
  const u = streetPart.match(/^(.*?)[,\s]+((?:apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr)\.?\s*#?\s*[\w-]+|#\s*[\w-]+)$/i);
  if (u) { out.street = u[1]; out.unit = u[2]; } else out.street = streetPart;
  // "12 Main St, Apt 5 Orlando, FL": the unit written after the comma, in front of the city.
  // Its number needs a digit, so a city like "Ste Genevieve" stays whole.
  const lead = !out.unit && out.city?.match(/^((?:apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr)\.?\s*#?\s*[\w-]*\d[\w-]*|#\s*[\w-]+)\s+(\S.*)$/i);
  if (lead) { out.unit = lead[1]; out.city = lead[2]; }
  // "Ci" isn't a street suffix; clients mean "Cir" (and USDOT records say CIR).
  out.street = out.street.replace(/\bCi\.?$/i, 'Cir');
  if (repaired) out.confident = false;
  return out;
}
