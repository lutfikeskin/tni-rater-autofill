// @ts-check
// The client's accidents, claims, violations and losses, for any carrier.

// The rows a Yes to the claims question opens (Progressive's incident date and type on Add Driver,
// AmWINS' Loss History): one per incident, the client's facts. The intake has no such rows, only
// the claims box's free text, so they are never filled from it (no date or type is read out of
// it): each is the agent's (`source: 'fact'`), with this note pointing at what the intake says.
// `what`: the row's details, as the carrier asks them ("the incident's date and type").
/** @param {string} what @returns {(r: any) => string} */
export const incidentRowNote = (what) => (r) => {
  const notes = String(r.claims?.notes ?? '').replace(/\s+/g, ' ').trim();
  const quoted = notes.length > 100 ? `${notes.slice(0, 97)}...` : notes;
  return quoted
    ? `Enter ${what} from the client: the intake has them only as the claims box's notes ("${quoted}").`
    : `Enter ${what} from the client: the intake's claims box gives no details.`;
};
