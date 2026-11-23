// @ts-check
// Settings' "How it runs" line (canvas 21): one sentence from the Filling switches, derived on each
// draw and never stored. The switches' defaults are sidepanel.js's (on unless saved off).
import { SETTINGS } from './messages.js';

/**
 * @param {{ autoPages?: boolean, autoAdvance?: boolean, checkBeforeContinue?: boolean } | null | undefined} switches
 * @returns {string}
 */
function modeSaid(switches) {
  const s = switches ?? {};
  const pages = s.autoPages !== false ? SETTINGS.pagesAuto : SETTINGS.pagesManual;
  const next = s.autoAdvance === false ? SETTINGS.continueManual
    : s.checkBeforeContinue !== false ? SETTINGS.continueLook : SETTINGS.continueAuto;
  return `${pages}; ${next}.`;
}

export { modeSaid };
