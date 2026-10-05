// Which layout questions the replay page draws. A question with a condition seen in the
// recordings (`showWhen`, from scripts/lib/conditions.mjs) shows only while its trigger's answer
// is one it was seen showing with: unanswered or another answer hides it, as on the carrier's
// page. A question without one shows as before, and so does one whose trigger isn't on the page.
// Loaded by index.html and by test/replay-show-when.test.mjs.
// The trigger is found by the identity the layout gives it: question id, element id, data-id or
// name, and only for a field with none of those, its caption. Answers compare like the layout's
// options (spacing and case aside).
const replayNorm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
globalThis.replayShows = function replayShows(field, fields, textOf) {
  const when = field.showWhen;
  if (!when) return true;
  const key = ['q', 'id', 'dataId', 'name'].find((k) => when[k]);
  const i = fields.findIndex((f) => (key ? f[key] === when[key] : !f.q && !f.id && !f.dataId && !f.name && f.caption === when.caption));
  if (i < 0) return true;
  const text = replayNorm(textOf(fields[i], i));
  return text !== '' && when.is.some((v) => replayNorm(v) === text);
};
