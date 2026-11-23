// @ts-check
// What the panel needs of each product (ProductParts in types.js): the record's sections and
// fields, what an edit recomputes, how an unnamed client is said. The panel asks for the loaded
// intake's product here, so it draws and edits any product's record the same way. This module only
// wires each product in; the parts are the product's own.

import { SECTIONS, fieldInfo as commercialFieldInfo } from './schema.js';
import { rederive as commercialRederive } from './normalize.js';
import { PERSONAL_AUTO_PARTS } from './products/personal-auto/index.js';
import { productOf } from './products.js';

/** @import { ClientRecord, ProductParts } from '../types.js' */

/** @type {Record<string, ProductParts>} */
const PARTS = {
  'commercial-auto': { sections: SECTIONS, fieldInfo: commercialFieldInfo, rederive: commercialRederive, unnamed: 'Unnamed business' },
  'personal-auto': PERSONAL_AUTO_PARTS,
};

/** @param {ClientRecord | null | undefined} record @returns {ProductParts} */
export const partsOf = (record) => PARTS[productOf(record)];

/** The record's sections, for its product. @param {ClientRecord | null | undefined} record */
export const sectionsOf = (record) => partsOf(record).sections;

/**
 * A field of the record by its path, for its product.
 * @param {string} path
 * @param {ClientRecord | null | undefined} [record]
 */
export const fieldInfo = (path, record) => partsOf(record).fieldInfo(path);

/**
 * The answers an edit of `path` recomputes, by the record's product's own reading (normalize.js
 * rederive for commercial auto).
 * @param {ClientRecord} record
 * @param {string} path
 * @param {any} [options]
 * @returns {string[]}
 */
export const rederive = (record, path, options) => partsOf(record).rederive(record, path, options);
