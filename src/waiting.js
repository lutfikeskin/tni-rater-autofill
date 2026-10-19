// A helper button the fill didn't click, in the agent's words for the panel: the button by the
// name the page shows (the carrier action's `button`), and what it waits for by question, button
// and page, never an action id or a record path. pagekit's `waits` on each blocked helper; its
// `why` says the same in ids and paths, for the usage log.
import { fieldInfo } from './schema.js';

// "Done with this coverage (standard: …)" → "Done with this coverage".
const plain = (name) => String(name ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
// "ChangePaymentPlan" → "Change Payment Plan".
const pageName = (page) => String(page).replace(/^\/+|\/+$/g, '').replace(/([a-z])([A-Z])/g, '$1 $2');

/** The helper's button, by its id (`lookupVin:1`) or base id (`lookupVin`). */
export function helperName(plan, id) {
  const base = String(id ?? '').replace(/:\d+$/, '');
  const step = (plan ?? []).find((s) => s.kind === 'action' && (s.action === id || s.baseAction === base));
  return step?.button ?? step?.label ?? 'A button on this page';
}

/**
 * One blocked helper (pagekit report.blocked: `{ id, why, waits }`), as the panel says it.
 * @param {{ id: string, why?: string, waits?: object[] }} entry
 * @param {object[]} plan  the plan the fill used (its field and action steps)
 */
export function waitingText(entry, plan = []) {
  const field = (path) => {
    const name = plain((plan ?? []).find((s) => s.path === path && s.kind !== 'action')?.name ?? fieldInfo(path).label);
    return name && name !== path ? name : 'an answer on this page';
  };
  const parts = (entry.waits ?? []).map((w) => w.say
    ?? (w.any ? `one of ${[...new Set(w.any.map(field))].join(' / ')}`
      : w.action ? `${helperName(plan, w.action)} to be clicked`
        : w.pages ? `the ${w.pages.map(pageName).join(' / ')} page`
          : field(w.path)));
  const name = helperName(plan, entry.id);
  if (parts.length) return `${name}: waiting for ${[...new Set(parts)].join(', ')}`;
  // Not a wait (an Email or Fax box ticked; a click whose result didn't show): the reason as is.
  return entry.why && !entry.why.startsWith('waiting for') ? `${name}: ${entry.why}` : name;
}
