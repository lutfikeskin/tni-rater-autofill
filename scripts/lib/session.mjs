// @ts-check
// One quote, one fill run or one problem report told as a story from the central usage log
// (REC-08): what the agent reported beside the fill it names (its blockers, what failed or was left
// for the agent and why) and the page's layouts around it, and a session's timeline in time order.
// `npm run session` prints it (scripts/session.mjs); scripts/review.mjs puts the join under each
// problem report. It reads only what the usage log already holds, no client data beyond it.

// What a timeline shows: the agent's and the panel's events that tell what happened on the page.
const TIMELINE = new Set(['intake_loaded', 'page_view', 'fill_run', 'fill_field', 'fill_error', 'field_change', 'agent_click', 'page_layout', 'problem_report', 'check_dismissed', 'ai_decision']);
const RESULTS_TO_SHOW = new Set(['failed', 'leftRequired', 'unfamiliar']);
const NEAR_MS = 5 * 60 * 1000;

const when = (e) => Date.parse(e.t);
const clock = (e) => String(e.t ?? '').slice(11, 19);
const oneLine = (s, max = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The fill a problem report names (`run`, which the panel sends), else the last fill on its page in
 * the same quote before it; that fill's failed, left and unfamiliar fields; and the layouts of its
 * page logged within 5 minutes either side, with their reasons.
 * @param {any} report  a problem_report event
 * @param {any[]} events  the usage log, in time order
 */
export function problemJoin(report, events) {
  const near = (e) => e.session === report.session && Math.abs(when(e) - when(report)) <= NEAR_MS;
  const run = (report.run && events.find((e) => e.type === 'fill_run' && e.run === report.run))
    ?? events.filter((e) => e.type === 'fill_run' && near(e) && e.page === report.page && when(e) <= when(report)).at(-1) ?? null;
  const fields = run?.run ? events.filter((e) => e.type === 'fill_field' && e.run === run.run && RESULTS_TO_SHOW.has(e.result)) : [];
  const layouts = events.filter((e) => e.type === 'page_layout' && near(e) && e.page === report.page).map((e) => ({ t: e.t, reason: e.reason ?? null, after: when(e) >= when(report) }));
  return { run, fields, layouts };
}

/**
 * The join as Markdown lines, indented under a report's own line.
 * @param {ReturnType<typeof problemJoin>} join
 */
export function problemLines({ run, fields, layouts }) {
  const lines = [];
  if (!run) lines.push('  - No fill on this page in the 5 minutes before it.');
  else {
    const blockers = (run.blockerList ?? []).map((b) => oneLine(typeof b === 'string' ? b : JSON.stringify(b), 120));
    lines.push(`  - Its fill${run.run ? ` \`${run.run}\`` : ''} at ${clock(run)}${run.auto ? ` (${run.auto === true ? 'automatic' : run.auto})` : ''}: ${run.filled ?? 0} filled, ${run.failed ?? 0} failed, ${run.leftRequired ?? 0} left for the agent, ${run.unknown ?? 0} unfamiliar; ${run.advanced ? `continued (${oneLine(run.advanced, 60)})` : 'not continued'}${blockers.length ? `; held by ${blockers.join('; ')}` : ''}.`);
    for (const f of fields) lines.push(`    - ${f.result}: ${oneLine(f.label, 80) || f.key || '?'}${f.reason ? ` (${oneLine(f.reason, 120)})` : ''}`);
  }
  if (layouts.length) lines.push(`  - Layouts of its page: ${layouts.map((l) => `${clock(l)} ${l.reason ?? '?'}${l.after ? ' (after)' : ''}`).join(', ')}.`);
  return lines;
}

/**
 * One event as a timeline line.
 * @param {any} e
 */
function said(e) {
  switch (e.type) {
    case 'page_view': return `page ${e.page ?? '?'}${e.step ? ` · ${e.step}` : ''}`;
    case 'fill_run': return `fill${e.run ? ` \`${e.run}\`` : ''}${e.auto ? ` (${e.auto === true ? 'automatic' : e.auto})` : ''}: ${e.filled ?? 0} filled, ${e.failed ?? 0} failed, ${e.leftRequired ?? 0} left, ${e.unknown ?? 0} unfamiliar in ${((e.ms ?? 0) / 1000).toFixed(1)} s; ${e.advanced ? `continued (${oneLine(e.advanced, 60)})` : 'not continued'}${e.blockerList?.length ? `; held by ${e.blockerList.map((b) => oneLine(b, 80)).join('; ')}` : ''}`;
    case 'fill_field': return `  ${e.result}: ${oneLine(e.label, 80) || e.key || '?'}${e.reason ? ` (${oneLine(e.reason, 120)})` : ''}`;
    case 'fill_error': return `fill error: ${oneLine(e.error, 160)}`;
    case 'field_change': return `${e.by === 'page' ? 'the page' : 'the agent'} changed ${oneLine(e.label, 80) || e.key || '?'}${e.change ? ` (${e.change})` : ''}`;
    case 'agent_click': return `the agent clicked "${oneLine(e.text, 60)}"`;
    case 'page_layout': return `layout (${e.reason ?? '?'}): ${(e.fields ?? []).length} question${(e.fields ?? []).length === 1 ? '' : 's'}${e.messages?.length ? `, messages: ${e.messages.map((m) => oneLine(m, 60)).join('; ')}` : ''}`;
    case 'problem_report': return `PROBLEM REPORT: ${oneLine(e.text, 300)}`;
    default: return e.type;
  }
}

/**
 * A session's, a fill run's or a problem report's story, as Markdown: the quote it belongs to, in
 * time order (a run: its quote's events from its page view before it to the next page; a report:
 * its quote's, with the join under it). Null when the id names none of them.
 * @param {string} id  a usage session id, a fill run's `run`, or a problem report's event id
 * @param {any[]} events  the usage log, in time order
 * @returns {string | null}
 */
export function sessionStory(id, events) {
  const report = events.find((e) => e.type === 'problem_report' && e.id === id);
  const run = events.find((e) => e.type === 'fill_run' && e.run === id);
  const session = report?.session ?? run?.session ?? (events.some((e) => e.session === id) ? id : null);
  if (!session) return null;
  let mine = events.filter((e) => e.session === session && TIMELINE.has(e.type)).filter((e) => e.type !== 'fill_field' || RESULTS_TO_SHOW.has(e.result));
  if (run) {
    // From the page view before the run to the next one after it.
    const i = mine.indexOf(run);
    const from = mine.slice(0, i).findLastIndex((e) => e.type === 'page_view');
    const next = mine.slice(i + 1).findIndex((e) => e.type === 'page_view');
    mine = mine.slice(Math.max(0, from), next < 0 ? undefined : i + 1 + next);
  }
  const first = mine[0];
  const out = [`# ${report ? 'Problem report' : run ? 'Fill run' : 'Quote session'} ${id}`, '',
    `Session \`${session}\`${first?.agent ? ` · agent ${first.agent}` : ''}${first?.v ? ` · ${first.v}${first.channel ? ` ${first.channel}` : ''}` : ''} · ${mine.length} events.`, ''];
  if (report) out.push(`Reported at ${clock(report)} on ${report.page ?? '?'}: ${oneLine(report.text, 500)}`, '', ...problemLines(problemJoin(report, events)), '');
  out.push('| Time | +s | Carrier | What |', '| --- | --- | --- | --- |');
  let last = first ? when(first) : 0;
  for (const e of mine) {
    out.push(`| ${clock(e)} | ${((when(e) - last) / 1000).toFixed(1)} | ${e.carrier ?? ''} | ${said(e).replace(/\|/g, '/')} |`);
    last = when(e);
  }
  return `${out.join('\n')}\n`;
}
