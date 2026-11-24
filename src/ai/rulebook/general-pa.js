// @ts-check
// TNI's personal-auto quoting rules as Luna reads them: decided once for every personal-auto
// carrier. Luna gets this part and its carrier's (src/ai/tni-rules.js), never commercial auto's
// general part (USDOT, CDL, cargo, trailer interchange).

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const generalPa = {
  title: 'TNI (Truckers National Insurance) personal-auto quoting rules for every carrier',
  sections: [
    { heading: 'Every personal-auto carrier', rules: [
      { id: 'general-pa.intake-truth', kind: 'intake', text: 'The intake (the client\'s TNI Personal Auto Insurance Quote Application) is the source of truth for facts about the client. Never invent a fact the intake doesn\'t give.' },
      { id: 'general-pa.standards-first', kind: 'workflow', text: 'Workflow and endorsement questions the intake doesn\'t cover use TNI\'s personal-auto standard answers in these rules. Prefer the TNI rule where one applies.' },
      { id: 'general-pa.middle-initial', kind: 'workflow', text: 'Driver and owner names: when a second name appears in the first-name box (such as a middle name or patronymic), enter the first word in First Name and the second name\'s first letter in Middle Initial.' },
      { id: 'general-pa.client-facts', kind: 'agent', text: 'A client fact the intake doesn\'t give (incidents/violations, Social Security number, blank year licensed, or an occupation outside clear non-employed statuses) is the agent\'s: leave it.' },
      { id: 'general-pa.agent-decides', kind: 'agent', text: 'The agent decides: MVR and CLUE report orders, anything the client must sign or bind, payment or bank details, and moving between steps.' },
    ] },
  ],
};
