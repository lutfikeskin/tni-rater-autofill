// @ts-check
// Intake form registry: detects which PDF form a raw AcroForm field map belongs to and routes it to
// that form's normalizer. Today only the TNI Commercial Quote Application is registered; a second
// product's intake PDF registers its own entry here without changing the panel's load path.

import { UNKNOWN_INTAKE_ERROR, isCommercialAutoIntake, normalizeIntake } from './normalize.js';

/** @import { IntakeForm, IntakeResult } from '../types.js' */

/** @type {IntakeForm[]} */
export const INTAKE_FORMS = [
  {
    id: 'tni-commercial-auto',
    product: 'commercial-auto',
    name: 'TNI Commercial Quote Application',
    detect: isCommercialAutoIntake,
    normalize: normalizeIntake,
    error: UNKNOWN_INTAKE_ERROR,
  },
];

/**
 * First registered intake form whose detector accepts `raw`, or null when none matches.
 * @param {Record<string, string | boolean>} raw
 * @param {readonly IntakeForm[]} [forms]
 * @returns {IntakeForm | null}
 */
export function detectIntakeForm(raw, forms = INTAKE_FORMS) {
  return forms.find((f) => f.detect(raw)) ?? null;
}

/**
 * Error message when no registered form accepts the PDF: with one form, that form's own error;
 * with several, a message naming all registered forms.
 * @param {readonly IntakeForm[]} forms
 * @returns {string}
 */
function unknownFormError(forms) {
  if (forms.length === 1 && forms[0].error) return forms[0].error;
  if (!forms.length) return 'No intake form is registered to read this PDF.';
  const names = forms.map((f) => f.name);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
  return `This PDF does not look like a supported intake form (${listed}). Make sure you selected a fillable intake PDF.`;
}

/**
 * Detect the intake form for `raw` and normalize it with that form's normalizer.
 * Passes options (such as `today`) through to the form's normalizer, stamps `form: form.id` on a
 * successful result, and guarantees `record.product === form.product`.
 * @param {Record<string, string | boolean>} raw
 * @param {{ today?: Date, forms?: readonly IntakeForm[] }} [opts]
 * @returns {IntakeResult | { error: string }}
 */
export function readIntake(raw, opts = {}) {
  const { forms = INTAKE_FORMS, ...rest } = opts;
  const form = detectIntakeForm(raw, forms);
  if (!form) return { error: unknownFormError(forms) };
  const result = form.normalize(raw, rest);
  if ('error' in result) return result;
  const record = result.record.product === form.product
    ? result.record
    : { ...result.record, product: form.product };
  return { ...result, form: form.id, record };
}
