// The side panel's decision logic for a page's report: which report is whose, what is left for the
// agent, the answers and their sources, and when the quote counts as finished. No DOM: the report,
// the steps and the dock draw it.
// One part of the panel; sidepanel.js wires the parts together.
import { resolutionOf } from '../../src/resolution.js';
import { neverReason } from '../../src/ai/common.js';
import { state } from './core.js';
import { stepScope, tabStep } from './scope.js';
import { pageOf } from './usage.js';

// Which report a page has: its tab and page (on a page or step about one vehicle or driver, that
// one: stepScope) and, on a one-address application (AmWINS, GEICO), its step, which changes while
// the address stays. Null off a rater page.
function reportKey(tabId, page, carrier, active = state.active, step = state.tabSteps?.get(tabId)) {
  if (!Number.isInteger(tabId) || !carrier) return null;
  return `${tabId}|${stepScope(page, carrier, active, step ?? null)}${carrier.layoutSteps ? step ?? '' : ''}`;
}

function currentReportKey() { return reportKey(state.tab?.id, pageOf(state.tab?.url), state.tab?.carrier); }

// The reports of other pages on the tab in front, in the order they were first filled: the
// answers' page menu (renderSteps). Only reports with answers; never the page in front's.
function earlierReports() {
  const here = currentReportKey();
  return [...state.reports.values()].filter((e) => e.fields && e.tabId === state.tab?.id && e.key !== here && e.nodes);
}

// An earlier page's name in the page menu: its step on a one-address application (AmWINS, GEICO),
// else its page's name spaced out ("AddDriver": Add Driver); on a page about one vehicle, trailer
// or driver, which one ("Add Driver · Driver 2"). From its report key (reportKey).
function reportTitle(entry) {
  const [, page = '', unit = '', step = ''] = String(entry?.key ?? '').split('|');
  const place = step || page.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  const which = /^(v|tr|d)(\d+)$/.exec(unit);
  return which ? `${place} · ${{ v: 'Vehicle', tr: 'Trailer', d: 'Driver' }[which[1]]} ${Number(which[2]) + 1}` : place;
}

// Whether the quote is done where TNI stops on this rater: the carrier's `finishedBy` action (GEICO's
// Print Quote Proposal) was clicked on this tab, the report in front is on that action's step or
// page, and nothing on it is left for the agent. The strip's Review page says "Quote done" and the
// dock says so (dockFor), where they said "Ready" and "Moving on is yours" before (the maintainer,
// 2026-10-23: the end of a GEICO quote read like every other page).
// A report whose fill halted, or that found no questions, isn't the quote done either.
function quoteFinished(carrier, report, page = pageOf(state.tab?.url), step = tabStep(carrier), doneActions = state.doneActions) {
  // A rater whose quote ends at a step, not a button (`finishedAt`, AmWINS's declaration on
  // Underwriting): a fill there with nothing left for the agent but the step's own items (otherLeft).
  // There: the step the report's own fill read (renderReport's `step`; rememberFill passes its fill's),
  // not the tab's, which stays at the last step it saw: Underwriting on the start page of the next
  // quote in the same tab (the review of PR #173).
  const at = carrier?.finishedAt;
  if (at) {
    const own = report?.step === undefined ? step : report.step;
    return [].concat(at.steps).includes(own) && !!report?.fields && !report.error && !report.stopped && !report.halted
      && (report.otherLeft ?? report.left ?? 0) === 0 && (report.waiting ?? 0) === 0;
  }
  const id = finishingAction(carrier, page, step);
  return !!id && !!report?.fields && !report.error && !report.stopped && !report.halted && !!doneActions?.has(id) && !doneActions.has(`${id}:changed`)
    && (report.left ?? 0) === 0 && (report.waiting ?? 0) === 0;
}

// The carrier's finishing action (`finishedBy`) where the page and step are its own (its `page` and
// `steps`, each a name or a list), else null.
function finishingAction(carrier, page, step) {
  const id = carrier?.finishedBy;
  if (!id) return null;
  const action = carrier.actions?.find((a) => a.id === id);
  const steps = [].concat(action?.steps ?? []);
  const pages = [].concat(action?.page ?? []);
  if (steps.length && !steps.includes(step)) return null;
  if (pages.length && !pages.includes(page)) return null;
  return id;
}

// An item left for the agent that the quote's end leaves them anyway (`finishedAt.left`, by rule
// name: AmWINS's Declaration, ticked by the agent before their Submit).
function finishLeftOk(carrier, x) {
  return [].concat(carrier?.finishedAt?.left ?? []).includes(x?.name);
}

// What the carrier's stop says on this page, or on the step this tab is on (`step`, its name):
// null where filling and clicking are allowed. Every check of a stop goes through it, so a stop
// step is refused wherever a stop page is (fill, follow-ups, Luna, the panel's buttons). `tabId`:
// the tab being filled or asked about (a follow-up's, the AI's), the shown one by default.
function stopNoteFor(carrier, page, step, tabId = state.tab?.id) {
  if (step === undefined) step = tabStep(carrier, tabId);
  // A screen that is the agent's (`stopButtons`), while that tab shows it on this page (noteStopScreen).
  const screen = state.stopScreens?.get(tabId);
  const said = screen?.page === page ? carrier?.stopButtons?.[screen.name]?.note : null;
  return carrier?.stopPages?.[page] ?? (step ? carrier?.stopSteps?.[step] : null)
    ?? (typeof said === 'function' ? said(state.intake?.record ?? null) : said) ?? null;
}

// The review items of fill reports that are questions with a field (`key`), as the kit's present
// takes them: [{ key, label }]. A row the intake doesn't have (`extra-row:`) is no field.
function reviewItems(frames) {
  return frames.flatMap((f) => [...['unknown', 'failed', 'noData', 'leftRequired', 'checks'].flatMap((k) => f[k] ?? []), ...(f.kept ?? []).filter((x) => x.differs)])
    .filter((x) => x.key && !String(x.key).startsWith('extra-row:')).map((x) => ({ key: x.key, label: x.label || null }));
}

// The answers of fill reports the panel lists (filled, and kept as the page had them), as present
// takes them, with the rule that answered each (`stepId`, for `agrees`).
function answerItems(frames) {
  return frames.flatMap((f) => [...(f.filled ?? []), ...(f.kept ?? []).filter((x) => !x.differs)])
    .filter((x) => x.key && !String(x.key).startsWith('extra-row:')).map((x) => ({ key: x.key, label: x.label || null, stepId: x.stepId ?? null }));
}

// Spacing, case and punctuation aside (as checkAnswers compares): a phone number formatted on blur.
function looseText(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function itemsLeft(frames) {
  const framed = (k) => frames.flatMap((f, frame) => (f[k] ?? []).map((x) => ({ ...x, frame })));
  const unknownKeys = new Set(framed('unknown').map((x) => x.key));
  return [
    ...framed('unknown').map((x) => ({ ...x, mark: 'needs', why: `Unfamiliar question${x.required ? ' (required)' : ''}: no TNI rule for it yet.` })),
    ...framed('failed').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'failed', why: `Couldn't fill: ${x.reason}` })),
    ...framed('noData').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'needs', why: resolutionOf(x, 'noData').explanation ?? 'Not on the intake.' })),
    ...framed('leftRequired').filter((x) => !unknownKeys.has(x.key)).map((x) => ({ ...x, mark: 'needs', why: 'Required, and not on the intake.' })),
    ...framed('kept').filter((x) => !x.otherStep && x.differs).map((x) => ({ ...x, mark: 'needs', why: 'The page already had a different value than the intake; it was kept.' })),
    // Defaults filled for the agent to confirm (e.g. marital status missing on the intake).
    ...framed('checks').filter((x) => !x.otherStep).map((x) => ({ ...x, mark: 'needs', why: resolutionOf(x, 'checks').explanation })),
  ];
}

// Where a fill's answers came from, by their plan step (plan.js): `fromOf`, the intake answers a
// derived one was worked out from; `groupOf`, the question several boxes answer together; `ticks`,
// the boxes our answer ticks. `editedBy`: an answer filled from a field the agent set or corrected
// in the panel (client details, an Intake check card's button such as Use Female) is the agent's, not the
// client's (also openPdf's `edited`).
function answerSources(plan) {
  const steps = plan ?? [];
  return {
    fromOf: new Map(steps.filter((s) => s.from).map((s) => [s.id, s.from])),
    groupOf: new Map(steps.filter((s) => s.group).map((s) => [s.id, s.group])),
    ticks: new Set(steps.filter((s) => s.group && s.value === true).map((s) => s.id)),
    editedBy: (path, from) => [path, ...(from ?? [])].some((p) => p && state.intake?.agentEdited?.includes(p)),
  };
}

// One question asked as several boxes (plan.js `group`: AmWINS' auto symbols): one row, the
// question and the boxes ticked, where the first box was (live run 2026-10-09: nine rows).
function groupRows(rows, ticks) {
  return rows.reduce((out, row) => {
    if (!row.group) return [...out, row];
    const g = out.find((r) => r.grouped === row.group)
      ?? (out.push({ label: row.group, grouped: row.group, ticked: [], standard: true, answer: false, frame: row.frame, order: row.order }), out.at(-1));
    // Ticked by our answer (filled now, earlier, or already so on the page).
    if (ticks.has(row.stepId)) g.ticked.push(row.label);
    g.answer ||= !!row.answer;
    g.standard &&= row.standard;
    g.value = g.ticked.join(', ') || 'none ticked';
    return out;
  }, []);
}

// Whether the panel may put the agent's own pick in for a question (agentAnswer): a choice the page
// offers, never one TNI leaves to the agent on the page (report orders, exclusions, signatures,
// payment: neverReason) or a lookup identity they must verify there (reviewOnly), and nothing on a
// stop page, step or screen.
function agentPickable(x, carrier = state.tab?.carrier, page = pageOf(state.tab?.url)) {
  if (!x?.key || !['radio', 'select', 'checkbox'].includes(x.controlKind)) return false;
  const options = choicesOf(x.controlKind, x.options);
  return options.length > 0 && !x.reviewOnly && !neverReason(x) && !stopNoteFor(carrier, page);
}

// The choices a question offers the agent: a checkbox's two states, or the options the page lists.
function choicesOf(kind, options) {
  return kind === 'checkbox' ? ['checked', 'unchecked'] : options ?? [];
}

// A choice as the agent reads it (a checkbox's two states named).
function choiceSaid(choice) {
  return choice === 'checked' ? 'Checked' : choice === 'unchecked' ? 'Unchecked' : String(choice);
}

export { agentPickable, answerItems, answerSources, choiceSaid, choicesOf, currentReportKey, earlierReports, finishingAction, finishLeftOk, groupRows, itemsLeft, looseText, quoteFinished, reportKey, reportTitle, reviewItems, stopNoteFor };
