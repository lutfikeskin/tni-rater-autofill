// Which layout questions the replay page draws. A question with a condition seen in the
// recordings (`showWhen`, from scripts/lib/conditions.mjs) shows only while its trigger's answer
// is one it was seen showing with: unanswered or another answer hides it, as on the carrier's
// page. A question without one shows as before, and so does one whose trigger isn't on the page.
// Loaded by index.html and by test/replay-show-when.test.mjs.
globalThis.replayShows = function replayShows(field, fields, textOf) {
  const when = field.showWhen;
  if (!when) return true;
  const i = fields.findIndex((f) => (when.q ? f.q === when.q : !f.q && f.caption === when.caption));
  if (i < 0) return true;
  const text = String(textOf(fields[i], i) ?? '').replace(/\s+/g, ' ').trim();
  return text !== '' && when.is.includes(text);
};
