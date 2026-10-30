// @ts-check
// One answer's resolution: the answer, how it was decided, why, and what it still needs from the
// agent (docs/intake-and-rules.md, "Resolution"). Built only from the fields a plan step or a fill
// report item already has (source, standard, manualOnly, reviewRequired / review, note, warn), so
// it always agrees with them. The panel and the AI read it (resolutionOf below), the usage log
// still the old fields. The page kit builds an item's the same way
// (pagekit.js resolveItems, a classic script that can't import this), and test/resolution.test.mjs
// holds both to the old fields.

/** @import { FieldStep, FillItem, Resolution } from '../types.js' */

const blank = (v) => v === null || v === undefined || v === '';

/**
 * A field step's resolution, as the plan decides it before the fill.
 * @param {Pick<FieldStep, 'value' | 'source' | 'manualOnly' | 'reviewRequired' | 'ignore' | 'verifyOnly' | 'note' | 'warn'>} step
 * @returns {Resolution}
 */
export function stepResolution(step) {
  const status = step.manualOnly ? 'agent'
    : step.ignore || step.verifyOnly ? 'kept'
    : blank(step.value) ? 'open'
    : step.reviewRequired ? 'review'
    : step.warn ? 'confirm'
    : 'answered';
  return { answer: step.value ?? null, method: step.source ?? null, explanation: step.note ?? step.warn ?? null, status };
}

// What a report list says of its items (an agent's-only item is the agent's in any list).
/** @type {{ [list: string]: Resolution['status'] }} */
export const LIST_STATUS = { filled: 'answered', kept: 'kept', noData: 'open', leftRequired: 'open', failed: 'failed', unknown: 'unknown' };

/**
 * A fill report item's resolution: its list's word for it, and the answer of the plan step that
 * answered it (`answer`), none for an item left open or the agent's.
 * @param {FillItem} item
 * @param {string} list  the report list it is in: filled, kept, noData, leftRequired, failed, unknown or checks
 * @param {any} answer  its plan step's value (null without a step)
 * @returns {Resolution}
 */
export function itemResolution(item, list, answer) {
  const status = item.manualOnly ? 'agent' : list === 'checks' ? (item.review ? 'review' : 'confirm') : LIST_STATUS[list];
  return { answer: status === 'agent' || status === 'open' || status === 'unknown' ? null : answer ?? null, method: item.source ?? null, explanation: item.note ?? item.reason ?? null, status };
}

/**
 * What the panel and the AI read of an item: its resolution, else one rebuilt from its fields (a
 * report kept from a build before resolutions, or an item the panel put together, such as a
 * restored AI suggestion). Without its plan step the rebuilt one has no answer; whether an item is
 * the agent's alone, its method and its explanation don't depend on its list.
 * @param {FillItem} item
 * @param {string} [list]  the report list it is in (noData when unknown)
 * @returns {Resolution}
 */
export function resolutionOf(item, list = 'noData') {
  if (item.resolution) return item.resolution;
  const rebuilt = itemResolution(item, list, null);
  // A build before items carried `source` marked a TNI standard by `standard` alone.
  return rebuilt.method == null && item.standard ? { ...rebuilt, method: 'standard' } : rebuilt;
}

// A TNI standard answer (the panel's tag), and an item the agent answers alone (never the AI's).
/** @param {FillItem} item @param {string} [list] */
export const isStandard = (item, list) => resolutionOf(item, list).method === 'standard';
/** @param {FillItem} item */
export const agentsAlone = (item) => resolutionOf(item).status === 'agent';
