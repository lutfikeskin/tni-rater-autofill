// @ts-check
// The personal-auto product: what the extension needs of it, from its own modules only (its form,
// its record's fields). Registered in src/products.js, src/intake-forms.js and src/product-parts.js.

import { formVersion } from './form.js';
import { readPersonalAuto, UNKNOWN_FORM_ERROR } from './read.js';
import { SECTIONS, fieldInfo } from './sections.js';

/** @import { IntakeForm, ProductParts } from '../../../types.js' */

/** @type {IntakeForm} */
export const PERSONAL_AUTO_FORM = {
  id: 'tni-personal-auto',
  product: 'personal-auto',
  name: 'TNI Personal Auto Insurance Quote Application',
  detect: (raw) => formVersion(raw) != null,
  normalize: readPersonalAuto,
  error: UNKNOWN_FORM_ERROR,
};

/** @type {ProductParts} */
export const PERSONAL_AUTO_PARTS = {
  sections: SECTIONS,
  fieldInfo,
  // No answer of the record is read from another one yet: an edit recomputes nothing.
  rederive: () => [],
  unnamed: 'Unnamed client',
  // Luna's intake reviews read commercial auto's claims box and coverages (NTL, GL) and set its
  // gender values: none for personal auto, whose form asks each driver's gender, until it has its own.
  aiReviews: false,
};
