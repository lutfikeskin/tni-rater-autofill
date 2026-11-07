// @ts-check
// Which federal filings the intake's "which filings" box asks for, read once for every carrier that
// ticks filings by name (GEICO's Add Filings boxes and filing type, AmWINS' BMC-91, MCS-90 and
// BMC-32, Progressive's Federal filing). TNI, 2026-11-07 (the maintainer, audit CARR-01): filings follow GEICO's stricter reading,
// shared by the carriers. Each carrier maps the result onto its own boxes and words its own notes.
//
// - A federal liability filing is named by BMC-91 (or 91X), MCS-90 or "federal liability". "Federal"
//   alone is one only when no cargo filing is named.
// - A cargo filing (BMC-34, BMC-32, "cargo") isn't a liability filing, so "Federal BMC-34" or
//   "Federal cargo filing" is a cargo filing only: whether a liability filing is needed too is the
//   agent's (`liability` null), never ticked. So it is beside a state filing ("State filing and
//   BMC-34"): that box doesn't name only state filings.
// - A state or intrastate filing is a state filing. A box naming only state filings has no federal
//   liability filing (`liability` false).
// - A cargo filing the text rules out ("no cargo filing", "without BMC-34", "cargo not needed") is a
//   cargo No, not a cargo request. One it both rules out and asks for ("BMC-34, no cargo filing") is
//   the agent's (`cargo-conflict`), and so is a liability filing only "federal" could name then.
// - A box naming only an SR-22 or FR-44, or one naming none of these, leaves both to the agent (null).

const ONLY_FR = /^\s*(?:sr[\s-]?22|fr[\s-]?44)(?:\s*(?:,|\/|&|and)\s*(?:sr[\s-]?22|fr[\s-]?44))*\s*$/i;
const FED_LIAB = /\bbmc[\s-]?91x?\b|\bmcs[\s-]?90\b|\bfederal\s+liab/i;
const FEDERAL = /\bfederal\b/i;
const CARGO = /\bbmc[\s-]?3[24]\b|\bcargo\b/i;
// A cargo filing ruled out: "no / not / without / excluding / except (a / any) (federal) cargo
// (filing)" or "BMC-34", and "cargo (filing) (is) not needed / required / wanted", "cargo: none",
// "cargo N/A".
const NO_CARGO = /\b(?:no|not|without|exclud(?:e|es|ed|ing)|except)\s+(?:a\s+|any\s+)?(?:federal\s+)?(?:cargo|bmc[\s-]?3[24])\b(?:\s+filings?\b)?|\b(?:cargo|bmc[\s-]?3[24])(?:\s+filings?)?\s*(?:(?:is|are)\s+)?(?:not\s+(?:needed|required|wanted)\b|:?\s*(?:none\b|n\/a(?![a-z])))/gi;
const STATE = /\bstate\b|\bintrastate\b/i;

/**
 * Why a federal filing is left to the agent: `unnamed` (no box, or it names neither a federal nor a
 * state filing), `sr-fr-only` (only an SR-22 or FR-44), `cargo` (a cargo filing, with no liability
 * filing named), `cargo-conflict` (a cargo filing both asked for and ruled out).
 * @typedef {'unnamed' | 'sr-fr-only' | 'cargo' | 'cargo-conflict'} FilingsOpen
 */

/**
 * What the intake's "which filings" text asks for.
 * @param {unknown} text  `operations.filingsWhich`
 * @returns {{ liability: boolean | null, cargo: boolean | null, state: boolean, srFrOnly: boolean, open: FilingsOpen | null }}
 *   `liability`: a federal liability filing (BMC-91 / MCS-90), `cargo`: a federal cargo filing
 *   (BMC-34 / BMC-32), each true, false or null (the agent's, `open` saying why); `state`: a state
 *   filing is named; `srFrOnly`: only an SR-22 or FR-44 is named.
 */
export const filingsIntent = (text) => {
  const t = String(text ?? '').trim();
  if (!t) return { liability: null, cargo: null, state: false, srFrOnly: false, open: 'unnamed' };
  if (ONLY_FR.test(t)) return { liability: null, cargo: null, state: false, srFrOnly: true, open: 'sr-fr-only' };
  // A cargo filing asked for (true), ruled out (false), or both (null: the agent's).
  const ruledOut = new RegExp(NO_CARGO.source, 'i').test(t);
  const asked = CARGO.test(t.replace(NO_CARGO, ' '));
  const cargo = ruledOut && asked ? null : asked;
  /** @type {FilingsOpen | null} */
  const cargoOpen = cargo === null ? 'cargo-conflict' : null;
  const state = STATE.test(t);
  if (FED_LIAB.test(t)) return { liability: true, cargo, state, srFrOnly: false, open: cargoOpen };
  if (FEDERAL.test(t)) return cargo === false ? { liability: true, cargo, state, srFrOnly: false, open: null } : { liability: null, cargo, state, srFrOnly: false, open: cargoOpen ?? 'cargo' };
  if (cargo !== false) return { liability: null, cargo, state, srFrOnly: false, open: cargoOpen ?? 'cargo' };
  if (state) return { liability: false, cargo: false, state, srFrOnly: false, open: null };
  return { liability: null, cargo: ruledOut ? false : null, state, srFrOnly: false, open: 'unnamed' };
};
