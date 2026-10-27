// @ts-check
// TNI's quoting rules as Luna reads them: one part for every carrier (rulebook/general.js) and one
// per carrier (rulebook/<carrier>.js), each entry a short rule with an id. Luna gets the general part
// and its own carrier's (rulebookFor); a carrier without a part gets none.
//
// The fill engine follows the same rules (src/carriers/*.js), and docs/intake-and-rules.md records
// which answers are TNI's. A `standard` entry is a TNI answer that a carrier rule fills with
// `source: 'standard'` and names in `tni` (or a carrier action does); every rule that can be
// `standard` names an entry of the general part or its own carrier's part. test/rulebook.test.mjs
// checks both ways, so a new standard changes the code and this rulebook together. The bake-off task
// (test/bakeoff/instructions.md) is a separate, hand-kept copy for its one practice course, scored
// against its own answer key; nothing checks its text against this rulebook.
//
// The entries are the first sources of every page review, in this order, so each carrier's requests
// share the same start for the provider's prompt cache: keep ids and wording stable, and bump Luna's
// POLICY_VERSION (src/ai/luna.js) when the evidence changes.
import { general } from './rulebook/general.js';
import { progressive } from './rulebook/progressive.js';
import { amwins } from './rulebook/amwins.js';
import { geico } from './rulebook/geico.js';

/** @import { RulebookEntry, RulebookPart } from '../../types.js' */

export const GENERAL = general;
/** @type {Record<string, RulebookPart>} */
export const CARRIER_PARTS = { progressive, amwins, geico };

// The general part, then the carrier's, each entry with its section heading.
/** @param {string} carrier @returns {(RulebookEntry & { section: string })[]} */
export function rulebookFor(carrier) {
  const part = Object.hasOwn(CARRIER_PARTS, carrier) ? CARRIER_PARTS[carrier] : null;
  if (!part) return [];
  return [general, part].flatMap((p) => p.sections.flatMap((s) => s.rules.map((rule) => ({ ...rule, section: s.heading }))));
}
