// The state a carrier quote is for, picked on the carrier's own page (Progressive's home page,
// AmWINS' start page), against the intake's garaging state. On 2026-10-08 a Florida intake went on
// a quote started in Utah: nothing said so until Progressive refused the Florida ZIP on Add
// Vehicle. The side panel warns as soon as the pick and the intake disagree.
//
// A carrier says which control it is: `quoteState: { pages, key }` (the field key the recorder
// reports for it). The extension fills neither Progressive's pick nor an agent's change of AmWINS'
// (agent edits are never replaced), so this is a warning only.

import { STATES } from './util.js';

const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

// The carriers' own names for a state: AmWINS lists "Washington DC".
const ALIASES = { 'washington dc': 'DC' };

// A state's two-letter code, from its code or its name ("FL", "Florida", "florida.", Progressive's
// "District of Columbia (DC)"); else null (a placeholder such as "Select a state").
export function stateCode(value) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const tagged = s.match(/\(([A-Za-z]{2})\)$/)?.[1]?.toUpperCase();
  if (tagged && STATES[tagged]) return tagged;
  const plain = s.replace(/\./g, '').trim();
  if (STATES[plain.toUpperCase()]) return plain.toUpperCase();
  return BY_NAME[plain.toLowerCase()] ?? ALIASES[plain.toLowerCase()] ?? null;
}

// A recorded change of the carrier's quote-state control: the state picked (its code), null when
// the pick is no state (back to the placeholder); undefined for any other control.
export function quoteStatePick(carrier, page, change) {
  const q = carrier?.quoteState;
  if (!q || !q.pages.includes(page) || change?.key !== q.key) return undefined;
  return stateCode(change.after);
}

// The picked state against the intake's: names of both when they differ; null when they agree or
// the intake has no state (an address it couldn't split: nothing to compare).
export function stateMismatch(code, record) {
  const intake = stateCode(record?.garaging?.state);
  if (!code || !intake || code === intake) return null;
  return { picked: STATES[code], intake: STATES[intake] };
}
