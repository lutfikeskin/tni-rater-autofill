// @ts-check
// Is the quote for state X: the quote's state is the garaging state (as the quote on Progressive's
// home page is started). normalize writes it as a two-letter code, and the panel saves an agent's
// edit as one (parseEdit; TNI, 2026-11-03), so every carrier reads only the code.
import { STATES } from '../util.js';
/** @import { ClientRecord } from '../../types.js' */

/** @typedef {keyof typeof STATES} StateCode */

const garaging = (record) => String(record.garaging?.state ?? '').trim();

/**
 * The garaging state is `code`, written as the code in any case ("TX", " tx "), never its name.
 * @param {ClientRecord} record @param {StateCode} code
 */
export const garagingIs = (record, code) => garaging(record).toUpperCase() === code;
