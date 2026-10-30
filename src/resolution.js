// @ts-check
// One answer's resolution: the answer, how it was decided, why, and what it still needs from the
// agent (docs/intake-and-rules.md, "Resolution"). Built only from the fields a plan step or a fill
// report item already has (source, standard, manualOnly, reviewRequired / review, note, warn), so
// it always agrees with them; nothing reads it yet. The page kit builds an item's the same way
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
