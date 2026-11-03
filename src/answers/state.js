// @ts-check
// Is the quote for state X: the quote's state is the garaging state (as the quote on Progressive's
// home page is started). normalize writes it as a two-letter code; an agent may type it by hand.
import { STATES } from '../util.js';
/** @import { ClientRecord } from '../../types.js' */

/** @typedef {keyof typeof STATES} StateCode */

const garaging = (record) => String(record.garaging?.state ?? '').trim();

/**
 * The garaging state is `code`, written as the code in any case ("TX", " tx "), never its name (GEICO).
 * @param {ClientRecord} record @param {StateCode} code
 */
export const garagingIs = (record, code) => garaging(record).toUpperCase() === code;

/**
 * The garaging state is `code`, written as the code or its full name in any case ("FL", "florida";
 * not "Fla."), as Progressive reads it. GEICO doesn't take the name: unifying the two is Karar 2.
 * @param {ClientRecord} record @param {StateCode} code
 */
export const garagingNamed = (record, code) => new RegExp(`^(${code}|${STATES[code]})$`, 'i').test(garaging(record));
