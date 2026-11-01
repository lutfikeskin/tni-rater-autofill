// The side panel: the quote's workflow: which fill runs when (automatic and follow-up fills), what each fill
// is about and its options, the dock and the page strip.
// One part of the panel; sidepanel.js wires the parts together.
import { sourcePlace } from '../../src/intake-source.js';
import { buildPlan, redactionTerms, supportedClass } from '../../src/plan.js';
import { advanceFor } from '../../src/units.js';
import { quoteProgress, stopScreen } from '../../src/carriers.js';
import { quotedCarrierPolicy } from '../../src/util.js';
import { fillEvents, redactor, sha256Hex, rulesHash, RULE_FILES, knownStep } from '../../src/usage.js';
import { stateCode, stateMismatch } from '../../src/quote-state.js';
import { notePremium, premiumHere } from '../../src/premium.js';
import { isStandard } from '../../src/resolution.js';
import * as usage from '../usage-log.js';
import { inExtension, popped } from './env.js';
import { $, forgetKeptReports, h, persistAgentKeys, persistDoneActions, persistUnitForms, retireAiOrigins, state, store } from './core.js';
import { firstUnits, save } from './intake.js';
import { checkShown, renderPickers, renderWarnings, showScreen } from './record.js';
import { pageOf, tellRecorder } from './usage.js';
import { afterFill, appendRows, assistAfterFill, fillPage, noteMissingUnit, pickListItem, renderReport, runKit, worldFor } from './fill.js';
import { pendingAi } from './assistant.js';
import { openPdf, pdfAvailable, pdfPageSaid } from './pdf-view.js';
import { editScope, fillSkip, fillSkipBy, formScoped, stepScope, tabStep, unitNameFor, unitScope } from './scope.js';
import { fillCurrent, fillErrorText, layoutErrorKind, sameLayoutScope, staleFill, stepOfResults, superseded } from './fill-checks.js';
import { DOCK_PHASES, phaseSaid } from './live.js';
import { answerSources, currentReportKey, earlierReports, finishLeftOk, finishingAction, groupRows, itemsLeft, quoteFinished, reportKey, reportTitle, stopNoteFor } from './report-model.js';
import { leftOf, listCounts } from './report-rows.js';
/** @import { CarrierConfig, FillOptions, FillReport } from '../../types.js' */

// ---------------------------------------------------------------------------------------------
// Automatic follow-up fills: once the agent has filled a page, questions that appear later
// (revealed by an answer, or in a panel that opens) are filled with the intake/standard answers.
// Fields that already have a value, or that the agent changed, are left alone.

// Automatic fills only run on the carrier's quote pages (never e.g. its quote-search page).
const onQuotePage = () => !!state.tab?.carrier && (!state.tab.carrier.autoFillUrl || state.tab.carrier.autoFillUrl.test(state.tab.url ?? ''));

// A step counts as continued per page, and on a page about one vehicle or driver (Progressive's
// Add Vehicle, Add Driver) per active vehicle/driver: Add Vehicle looks the same for every
// vehicle, and the next vehicle's page is a new step, not the agent going back. Other pages stay
// quote-wide, so changing a picker never makes a page the agent left new again.
// Which tab and vehicle/driver an event was on, without naming either: the tab's order in this
// quote and, on a page about one vehicle or driver, its number (t1, t2:v0, t1:d1). Reviews use
// it to keep two quote tabs, or two vehicles, apart (scripts/lib/transitions.mjs).
function viewOf(tabId, page, carrier = state.tab?.carrier) {
  if (!Number.isInteger(tabId)) return undefined;
  if (!state.viewTabs.has(tabId)) {
    state.viewTabs.set(tabId, state.viewTabs.size + 1);
    saveViews();
  }
  const entity = stepScope(page, carrier, state.active, tabStep(carrier, tabId)).split('|')[1];
  return `t${state.viewTabs.get(tabId)}${entity ? `:${entity}` : ''}`;
}

// Kept with the quote's session (in session storage, like the intake), so a panel that's closed
// and opened again numbers the quote's tabs as before, and a new quote starts from t1.
function saveViews() {
  store.set('views', { session: usage.currentSession()?.id ?? null, tabs: [...state.viewTabs] })?.catch?.(() => {});
}
function resetViews() {
  state.viewTabs = new Map();
  saveViews();
}

// `active`: the vehicle, driver and trailer the fill's plan is for (fillContext), which the agent's
// picker may have left since. `unitsListed`: the unit list on screen holds every intake unit
// (pickUnitToAdd), so its Looks Good may be clicked (advanceFor).
/** @type {(carrier: CarrierConfig, extra?: FillOptions, autoAdvance?: boolean, active?: object, unitsListed?: boolean) => FillOptions} */
const fillOptions = (carrier, extra = {}, autoAdvance = $('auto-advance').checked, active = state.active, unitsListed = false) => ({
  replaceChoices: !!carrier.replaceChoices,
  // Where the page takes an answer back (GEICO's Quote & Coverages: keepTakenBack), the field keys
  // this tab's fills answered, so a later fill keeps what the page shows there now. Keys only. The
  // agent's Fill this page passes none (fillPage): it gives the answer again.
  takenBack: carrier.keepTakenBack?.length ? { steps: carrier.keepTakenBack, keys: Object.fromEntries([...(state.filled?.keys() ?? [])].map((key) => [key, true])) } : null,
  // The field keys this tab's fills answered: one the page has reset since is given again only on a
  // quiet page (W43-21). Keys only.
  filledBefore: [...(state.filled?.keys() ?? [])],
  // Carriers whose pages never wait on a server per answer are filled a round at a time.
  batch: !!carrier.batch,
  // Steps of a one-address application already continued from (a step the agent goes back to
  // isn't continued again). Each entry is scoped by its own step, not the one the panel last heard
  // the tab was on: GEICO's Vehicles is continued per vehicle, its other steps once a quote, and
  // each of its steps per form and button (advance `byForm`: "Vehicles@next@<form>").
  doneSteps: [...state.doneSteps].map((s) => [s, s.slice(s.indexOf('|', String(pageOf(state.tab?.url)).length + 1) + 1)])
    .filter(([s, raw]) => s === stepScope(pageOf(state.tab?.url), carrier, active, carrier.layoutSteps ? knownStep(carrier, raw.split('@')[0]) : undefined) + raw).map(([, raw]) => raw),
  // Click the page's Continue when nothing is left for the agent (setting below), but never
  // while the agent hasn't approved the AI's selections on this page.
  advance: autoAdvance && carrier.advance && !pendingAi(state.tab?.id, pageOf(state.tab?.url)).length ? advanceFor(carrier, unitsListed) : null,
  // "Check answers before Continue": Continue only for the page as the agent approved it (Looks
  // right passes its receipt as `confirmed`). Kept on this computer, not in the usage log.
  hold: !!$('check-continue')?.checked,
  confirmed: null,
  // Add NTL done on this intake's quote survives a panel reload (its removal hold depends on it).
  doneActions: [...state.doneActions, ...(state.intake?.ntlAdded ? ['addNtl'] : [])],
  visitedPages: [...state.visitedPages],
  // The carrier's own stop (see showStopPage): the page kit refuses to fill or click there too.
  stopPages: Object.keys(carrier.stopPages ?? {}),
  // Steps that are the agent's (GEICO's MVR & CLUE, Payment Information), by name: the kit reads
  // the step on the page at the start and every round, as the panel's word on it can lag.
  stopSteps: Object.keys(carrier.stopSteps ?? {}),
  // Which vehicle, driver and trailer the plan is for, how many the intake lists, and the forms
  // earlier fills on this tab answered for them (unitForms): a form that may be another unit's is
  // left for the agent (pagekit unitHeld). Element names and numbers only.
  units: {
    active: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, active?.[list] ?? 0])),
    count: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, state.intake?.record?.[list]?.length ?? 0])),
    bound: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, { ...state.unitForms?.[list] }])),
  },
  // A form that names its driver (carrier.unitNames: Progressive's "Questions about <name>") is
  // filled only for the driver the plan is for (W43-37).
  formUnit: unitNameFor(carrier, extra.expectPage ?? pageOf(state.tab?.url), active, state.intake?.record),
  // What this tab's fills gave, by field key, with the unit each was for: a field still showing
  // another unit's answer gets this unit's (W43-38).
  givenBefore: Object.fromEntries([...(state.filled ?? [])].map(([key, x]) => [key, { path: x.path ?? null, shown: x.shown ?? null }])),
  // A page that shows a few units' rows at a time (Progressive's Rates): the kit pages through them.
  pager: carrier.unitPager ?? null,
  // Never change what the agent changed on this page, whether the fill is manual or automatic.
  skip: [...(state.agentKeys.get(editScope(pageOf(state.tab?.url))) ?? [])],
  ...extra,
});

// Which rules this copy fills with: the rule files' fingerprint (src/usage.js rulesHash), read
// from the extension's own package when the panel starts, on every fill_run. Null outside the
// extension or until it's read; then the run just carries none.
let rulesVersion = null;
if (inExtension) {
  Promise.all(RULE_FILES.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text()))).then(rulesHash)
    .then((hash) => { rulesVersion = hash; }).catch(() => {});
}

// What a fill is about, taken before it waits on anything (audit 2026-10-08, finding 5): its own
// id (`run`, shared by its events), the tab, carrier and page it fills, the intake and revision it
// fills from, the view and edit scope for its tab, and the panel's switches. The intake may be
// replaced or corrected while the carrier works; the results then belong to this context, not to
// the panel's current state (staleFill), and its bookkeeping goes to this tab (rememberFill).
// `ids`: the quote (usage session) and intake the fill began in, which its events keep when they're
// logged after another intake was loaded. `settings.overwrite` is the overwrite the fill used
// (never for an automatic fill), not the checkbox. `asked`: the agent's own Fill this page (not an
// automatic fill, nor Looks right, which continues the page as approved).
function fillContext({ tabId, carrier, page, tabUrl, auto = false, overwrite = false, asked = false }) {
  const session = usage.currentSession();
  return {
    run: crypto.randomUUID(), tabId, carrier, page, tabUrl, auto, overwrite, asked,
    intake: state.intake, revision: state.intakeRevision, ids: { session: session?.id ?? null, intakeId: session?.intakeId ?? null },
    view: viewOf(tabId, page, carrier), scope: editScope(page, carrier, tabStep(carrier, tabId)), active: { ...state.active },
    settings: { autoAdvance: !!$('auto-advance').checked, autoFollowUps: !!$('auto-followups').checked, autoPages: !!$('auto-pages').checked, overwrite: !!overwrite },
  };
}
function noteStaleFill(ctx) {
  logFillError(ctx, 'stale: intake changed during the fill');
  fillProblem(ctx, 'The intake changed during the fill: the page may hold earlier answers. Check it, then fill again.');
}

// Whether the fill's tab shows another page than the one it was asked for, as Chrome has the tab's
// address now (the panel's own word on it can lag a message). Unknown counts as not moved: the kit
// checks again as it starts.
async function pageMoved(ctx) {
  let url;
  try { ({ url } = await chrome.tabs.get(ctx.tabId)); } catch { return false; }
  const now = pageOf(url);
  return now != null && now !== ctx.page;
}
// A fill whose page moved on before it began: nothing was filled or clicked. The page in front now is
// filled as a new page when the agent fills each new page (runPendingPage, once the fill is over); a
// fill the agent asked for says so and is logged. An automatic one isn't: a follow-up for the page
// a Continue just left is routine.
function notePageMoved(ctx) {
  if (ctx.auto) return;
  logFillError(ctx, 'page moved before the fill began');
  fillProblem(ctx, 'The page changed before the fill began. Nothing was filled or clicked; fill the page in front.', 'notice');
}

// While a fill runs: the answers in so far, read from the page every half second (pagekit
// progress), listed as they go in (the live list, live-view.jsx) and counted in step 2 and the dock. Each frame sends
// only the rows after those the panel has from its list (`seen`, by the frame's list); a reading
// still under way skips the next. One the page hasn't answered for UNANSWERED_MS (a message box
// open on it holds its scripts, or a frame is stuck) is said in the dock and the list
// (`unanswered`); nothing is done to the page, and the fill goes on once it answers. Returns what
// stops the reading.
// The items the fill has judged so far come with them (pagekit progress `items`: what is left for the
// agent above the fill's cursor, one snapshot a round, sent only when the panel doesn't have that
// round's), each frame's latest kept, and listed with the answers in the page's order (liveEntries).
const UNANSWERED_MS = 5000;
function watchFill(ctx) {
  if (!inExtension) return () => {};
  const lists = new Map();
  // Each frame's latest items (pagekit `itemsAt`, the round's snapshot, and its list).
  const judged = new Map();
  let reading = null;
  const timer = setInterval(async () => {
    if (state.fillingFor?.run !== ctx.run) { clearInterval(timer); return; }
    if (reading != null) {
      if (Date.now() - reading >= UNANSWERED_MS && !state.fillingFor.unanswered) {
        state.fillingFor = { ...state.fillingFor, unanswered: true };
        renderSteps();
      }
      return;
    }
    reading = Date.now();
    let frames;
    try {
      const seen = Object.fromEntries([...[...lists].map(([list, rows]) => [list, rows.length]), ...[...judged].map(([frame, x]) => [`items@${frame}`, x.at])]);
      frames = await chrome.scripting.executeScript({ target: { tabId: ctx.tabId, allFrames: true }, world: worldFor(ctx.carrier),
        func: (s) => globalThis.__raterKit?.progress?.(s) ?? null, args: [seen] });
    } catch { return; /* the page is navigating */ } finally { reading = null; }
    const f = state.fillingFor;
    if (f?.run !== ctx.run) return;
    const answered = !!f.unanswered;
    // What the kit is doing between answers (pagekit `phase`: reading the page, waiting for it, a
    // helper's response, the premium, Continue): the top frame's while its fill runs (null while it
    // answers), else the first other frame's that says. Progressive's hidden frame, loaded with an
    // earlier page, reads it as every fill begins (the review of PR #170).
    const top = frames.find((x) => x.frameId === 0)?.result;
    const phase = top ? top.phase ?? null : frames.find((x) => x.result?.phase)?.result.phase ?? null;
    // Frames in the page's order (the top frame first), for listing their rows and items in turn.
    const order = frames.map((x) => x.result?.frame).filter(Boolean);
    for (const { result } of frames) {
      if (!result?.list) continue;
      // A list the frame has rewritten (an answer given again) comes whole (`since` 0), as a new one.
      const had = result.since ? lists.get(result.list) ?? [] : [];
      if (!result.since) for (const list of lists.keys()) if (list.startsWith(`${result.frame}:`)) lists.delete(list);
      lists.set(result.list, [...had.slice(0, result.since), ...result.rows.map((x) => ({ ...x, frame: result.frame }))]);
      if (Array.isArray(result.items)) judged.set(result.frame, { at: result.itemsAt, list: result.items.map((x) => ({ ...x, frame: result.frame })) });
    }
    // This step's answers only: another step's hidden fields filled again (otherStep) aren't its.
    const rows = [...lists.values()].flat().filter((x) => !x.otherStep);
    const itemsKey = [...judged].map(([frame, x]) => `${frame}@${x.at}`).join('|');
    const phaseKey = phase ? `${phase.name}|${phase.what ?? ''}` : '';
    if (!answered && phaseKey === (f.phaseKey ?? '') && itemsKey === (f.itemsKey ?? '') && rows.length === f.filled && rows.every((x, i) => f.rows[i] === x)) return;
    // A new fillingFor, not a change in place: the live list (live-view.jsx) redraws on the assignment.
    state.fillingFor = { ...f, unanswered: false, filled: rows.length, rows, items: [...judged.values()].flatMap((x) => x.list), itemsKey,
      ...(order.length ? { frames: order } : {}), phase, phaseKey };
    renderSteps();
  }, 500);
  return () => clearInterval(timer);
}

// Step 2's Stop: halts the running fill in every frame of its tab (pagekit stop), as an agent edit
// does. What is in stays; nothing more is filled or clicked, Continue included.
async function stopFill() {
  const f = state.fillingFor;
  if (!f || f.stopping) return;
  state.fillingFor = { ...f, stopping: true };
  $('fill-stop').disabled = true;
  renderSteps();
  try {
    // With the fill's run id: a fill that hasn't begun in a frame yet halts as it starts there.
    await chrome.scripting.executeScript({ target: { tabId: f.tabId, allFrames: true }, world: worldFor(f.carrier),
      func: (run) => globalThis.__raterKit?.stop?.(run) ?? false, args: [f.run] });
  } catch { /* the page is navigating: the fill ends anyway */ }
}

// Scrolling into view: at once for an agent who asked the system for less motion.
function scrollBehavior() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

// After a fill: the page's answers come into view (steps 2 and 3). An automatic fill doesn't pull
// the agent out of step 1 while they're working in it.
function showFinish({ auto = false } = {}) {
  if (auto && state.view === 'check' && $('check-view').contains(document.activeElement)) return;
  state.view = 'page';
  showScreen();
  renderSteps();
  $('page-view').scrollIntoView({ block: 'start', behavior: scrollBehavior() });
}
// The events of a fill, redacted with the intake it filled from.
/** @param {{ carrier: CarrierConfig, [key: string]: any }} ctx @param {FillReport[]} frames */
function logFill(ctx, frames, results, started) {
  if (ctx.carrier.practice) return;
  const redact = redactor(redactionTerms(ctx.intake.record));
  state.lastRuns?.set(`${ctx.tabId}|${ctx.page}`, { run: ctx.run, at: Date.now(), step: stepOfResults(ctx.carrier, results),
    blockers: frames.flatMap((f) => f.blockers ?? []).slice(0, 6).map((b) => redact(String(b)).slice(0, 120)) });
  // Why a unit list's Looks Good wasn't among the buttons (pickUnitToAdd), with the kit's blockers.
  usage.log(...fillEvents(ctx.listNote ? [...frames, { blockers: [ctx.listNote] }] : frames, {
    carrier: ctx.carrier.id, page: ctx.page, view: ctx.view, overwrite: ctx.overwrite, auto: ctx.auto, ms: Date.now() - started,
    redact: redactor(redactionTerms(ctx.intake.record)), keySalt: usage.currentSession()?.keySalt,
    run: ctx.run, rules: rulesVersion ?? undefined, settings: ctx.settings, step: stepOfResults(ctx.carrier, results),
  }));
}
// A rejected fill has no fill_run result to carry its rule version and switches.
function logFillError(ctx, error) {
  if (ctx.carrier.practice) return;
  usage.log({ type: 'fill_error', carrier: ctx.carrier.id, page: ctx.page, run: ctx.run,
    rules: rulesVersion ?? undefined, settings: ctx.settings, auto: ctx.auto, error: fillErrorText(ctx, error), ...ctx.ids });
}

// `drawn`: the page drew new questions (the recorder's new_fields), which a step that takes
// follow-ups only for those (`newQuestionsOnlySteps`) waits for.
function scheduleAutoFill(page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }, drawn = false) {
  if (state.autoPaused || !$('auto-followups').checked || !state.autoPages.has(page) || !onQuotePage() || stopNoteFor(state.tab?.carrier, page, undefined, ctx.tabId) || stateIssue()) return;
  if (drawn) state.autoDrawn = page;
  if (state.filling) { state.autoPending = true; return; }
  clearTimeout(state.autoTimer);
  state.autoTimer = setTimeout(() => { if (fillCurrent(ctx)) autoFill(page); }, 600);
}

async function autoFill(page) {
  // New questions drawn (scheduleAutoFill), used by this fill only: never left for a later one,
  // which may follow an answer.
  const drawn = state.autoDrawn === page;
  state.autoDrawn = null;
  // The client may have been cleared while this fill was waiting to run.
  if (state.autoPaused || state.filling || state.closing || state.resetting || !state.intake || !state.tab?.carrier || pageOf(state.tab?.url) !== page) return;
  if (stopNoteFor(state.tab.carrier, page) || stateIssue()) return;
  const { id: tabId, carrier } = state.tab;
  // A page or step without a report yet is new, not a follow-up: the agent moved to AmWINS' next
  // step themselves (same address, new questions). It's filled as a new page, with its report.
  if (!state.reports.has(reportKey(tabId, page, carrier))) { fillPage({ auto: 'page' }); return; }
  const stepBefore = state.tabSteps?.get(tabId);
  // A step the carrier redraws on every answer (GEICO's Quote & Coverages: newQuestionsOnlySteps)
  // is filled when it opens, on Fill this page, and when it draws new questions (the cargo
  // section's), never after an answer or a redraw.
  if (carrier.newQuestionsOnlySteps?.includes(stepBefore) && !drawn) return;
  // Before any waiting: the agent may pick another vehicle or tab, or load another intake, while
  // the carrier works (fillContext; the view is taken there).
  const ctx = fillContext({ tabId, carrier, page, tabUrl: state.tab.url, auto: true });
  await pickListItem(carrier, page, ctx);
  if (staleFill(ctx) || state.tab?.id !== tabId) return;
  // A fill the agent started while the list was read (Fill this page, Looks right) goes first;
  // this one follows it rather than running beside it.
  if (state.filling) { state.autoPending = true; if (drawn) state.autoDrawn = page; return; }
  state.filling = true;
  state.autoPending = false;
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  // The page moved on before the fill began (pageMoved): the page in front gets its fill after this.
  let moved = false;
  let unwatch = () => {};
  try {
    await tellRecorder('pause', tabId);
    await retireAiOrigins({ tabId, tabUrl: ctx.tabUrl, intake: ctx.intake, carrier });
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (!fillCurrent(ctx)) return;
    // The list page may have picked the next vehicle or driver: the plan is for that one.
    ctx.active = { ...state.active };
    // A unit no fill has a report for yet (the one the list added, or the next one's form): its
    // report is shown, as a new step's is (FL live run 6, 2026-10-21: vehicles 2 and 3 were filled by
    // follow-ups while the panel still showed the answers of the vehicle before).
    const unseen = !state.reports.has(reportKey(tabId, page, carrier, ctx.active, stepBefore));
    // Honor the latest switch after preparation, and log the same value used by the kit. The unit the
    // fill adds (pickUnitToAdd) has its "+" and chooser Next clicked only with it on (`click`).
    ctx.settings.autoAdvance = !!$('auto-advance').checked;
    const plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
    const skip = fillSkip(tabMaps(tabId).agentKeys, ctx.scope, ctx.page, carrier);
    const skipBy = fillSkipBy(tabMaps(tabId).agentKeys, ctx.page, carrier, ctx.active);
    // The tab moved on to another page meanwhile: that one gets its own fill (fillPage).
    if (await pageMoved(ctx)) { moved = true; notePageMoved(ctx); return; }
    const options = fillOptions(carrier, { overwrite: false, skip, ...(skipBy ? { skipBy } : {}), keepMarks: true, expectPage: ctx.page }, ctx.settings.autoAdvance, ctx.active, ctx.unitsListed);
    // Its answers listed as they go in, as a fill the agent asked for, from the first one in (`auto`:
    // a follow-up that answers nothing never replaces the report; W43-42, 2026-10-22: a 29-second
    // automatic fill showed nothing until it ended).
    state.fillingFor = { run: ctx.run, tabId, carrier, key: reportKey(tabId, page, carrier, ctx.active), filled: 0, rows: [], stopping: false, auto: true };
    unwatch = watchFill(ctx);
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, options]);
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (results.some((r) => r.result?.pageMoved)) { moved = true; notePageMoved(ctx); return; }
    // Filled with this intake: the tab's quote is this client's, so its layouts may be taken.
    // Only once the fill went through; a fill that failed proves nothing about the page.
    state.layoutReadyTabs.add(tabId);
    noteMissingUnit(results, ctx);
    const frames = results.map((r) => r.result).filter(Boolean);
    const retrying = rememberFill(frames, ctx);
    followUp = afterFill(frames, ctx);
    const hasWarnings = frames.some((f) => f.unknown?.length);
    // Held for the agent's check (Check answers before Continue): Looks right is in its report. A
    // unit form held as maybe another vehicle's or driver's (pagekit unitHeld) is said there too:
    // a quiet follow-up would leave the agent looking at the last form's report.
    const held = frames.some((f) => f.held || f.unitHeld);
    // Continue or a helper not clicked for something open over it on the page (pagekit `covered`,
    // `coveredHelpers`): said in the report, which a quiet follow-up wouldn't show.
    const covered = frames.some((f) => f.covered || f.coveredHelpers?.length);
    // Stopped by the agent: said as a stop, not as an error (as fillPage does).
    const stopped = state.fillingFor?.run === ctx.run && !!state.fillingFor.stopping && frames.some((f) => f.halted);
    const current = fillCurrent(ctx);
    // The page showed another step than the panel knew (the recorder's step came late): a new
    // step, with a report of its own, as above.
    const step = carrier.layoutSteps ? stepOfResults(carrier, results) : null;
    const newStep = !!step && step !== stepBefore && !state.reports.has(reportKey(tabId, page, carrier, ctx.active, step));
    // The fill whose helper this follows up held Luna back for it.
    const rendered = current && (newStep || unseen || held || covered || state.autoPaused || hasWarnings || state.assistPage === page);
    if (rendered) { renderReport(frames, { ...ctx, plan, retrying, stopped }); assistFrames = frames; }
    if (current && (newStep || unseen || held || covered)) showFinish({ auto: true });
    // This step's answers only: another step's hidden fields filled again (otherStep) aren't its.
    const added = frames.flatMap((f) => f.filled).filter((x) => !x.otherStep);
    const n = added.length + frames.reduce((k, f) => k + (f.actions?.length ?? 0), 0);
    if (n || hasWarnings || frames.some((f) => f.filled.length)) {
      logFill(ctx, frames, results, started);
      if (n && current && !rendered && reportShown()) {
        // Listed with the page's answers, marked new, and counted in step 2.
        // With their sources and groups as the report has them (answerSources, groupRows).
        const rctx = { tabId, page, carrier };
        const { fromOf, groupOf, ticks, editedBy } = answerSources(plan);
        const answers = groupRows(added.map((x) => ({ label: x.label || x.name, value: x.shown ?? '', standard: isStandard(x, 'filled'), path: x.path, from: fromOf.get(x.stepId), edited: editedBy(x.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId, answer: true, key: x.key, field: x.label ?? null, q: x.q ?? null })), ticks);
        appendRows([...answers, ...frames.flatMap((f) => f.actions ?? []).map((a) => ({ label: 'Clicked', value: a.text || a.id, kind: 'clicked' }))], rctx);
        state.reportFor.filled = (state.reportFor.filled ?? 0) + answers.filter((row) => row.answer).length;
        renderSteps();
        announce(`Filled ${n} follow-up question${n === 1 ? '' : 's'} automatically.`);
      }
      if (current) recordLayout(page);
    } else if (ctx.listNote || frames.some((f) => f.advanceDue || f.held)) logFill(ctx, frames, results, started);
  } catch (e) {
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    tabMaps(tabId).autoPaused = true;
    // The message may quote the page, so it's redacted with the origin intake.
    logFillError(ctx, e);
    fillProblem(ctx, 'Automatic filling paused after an error. Check the page, then fill again.');
  } finally {
    unwatch();
    if (state.fillingFor?.run === ctx.run) state.fillingFor = null;
    await tellRecorder('resume', tabId);
    state.filling = false;
    renderSteps();
    if (fillCurrent(ctx) && state.autoPending) scheduleAutoFill(page);
    // The page in front, which this fill wasn't for: its stop card, or its own fill.
    if (moved && fillCurrent(ctx)) {
      if (stopNoteFor(state.tab?.carrier, pageOf(state.tab?.url))) showStopPage();
      runPendingPage(ctx);
    }
  }
  if (!fillCurrent(ctx)) return;
  // The page moved on to a stop page while this ran: its card stays on top of this fill's report.
  if (stopNoteFor(state.tab?.carrier, pageOf(state.tab?.url))) showStopPage();
  runPendingPage(ctx);
  // A fill that halted on a step it couldn't read (GEICO's progress bar and title disagreeing:
  // pagekit reads nothing there) leaves the page to the agent: Luna isn't asked about it.
  const unread = formScoped(carrier) && !!assistFrames?.some((f) => f.halted && !knownStep(carrier, f.stepKey));
  if (assistFrames && !unread) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

function runPendingPage(ctx) {
  const pending = state.pagePending;
  state.pagePending = null;
  if (pending && pending === pageOf(state.tab?.url)) setTimeout(() => {
    if (fillCurrent(ctx) && pending === pageOf(state.tab?.url)) fillPage({ auto: 'page' });
  }, 300);
}

// Each page's question layout (ids, question text, options, which choice is picked; no typed
// text) goes into the usage log whenever it differs from the last one logged for that page, so
// layouts for every state and product collect themselves as agents quote, and a follow-up
// question's appearing and going away are both seen. scripts/build-layouts.mjs turns them into
// test pages. `reason`: fill, or what changed on the page (see scheduleLayout). One at a time, in
// order, so a page's layouts are logged in the order they were seen.
function recordLayout(page, reason = 'fill', job = layoutJob(page)) {
  const run = state.layoutChain.then(() => captureLayout(job, reason)).finally(() => { job.done = !job.waitsForFill; });
  state.layoutChain = run.catch(() => {});
  return run;
}

// A capture is asked for one quote, tab, page and active vehicle/driver. It's dropped when any of
// them has changed by the time the page is read or its answer comes back, so a page is never
// logged under another page's name, another client's quote, context or redaction.
// Corrected intake facts count too: the page may still show the old ones, and the context and
// redaction would come from the new.
function layoutJob(page, session = usage.currentSession()?.id) {
  return { session, tabId: state.tab?.id, carrier: state.tab?.carrier, page, active: JSON.stringify(state.active), revision: state.intakeRevision };
}

function jobCurrent(job) {
  return !!job.session && !!state.intake && usage.currentSession()?.id === job.session
    && state.tab?.id === job.tabId && state.tab?.carrier?.id === job.carrier?.id
    && pageOf(state.tab.url) === job.page && JSON.stringify(state.active) === job.active
    && state.intakeRevision === job.revision;
}

// The agent corrected the intake: a capture already reading the page is dropped (jobCurrent), and
// one still waiting is asked again for the corrected intake.
function intakeEdited() {
  state.intakeRevision++;
  showStateNote();
  const pending = state.layoutPending;
  if (!pending) return;
  cancelLayouts();
  for (const reason of pending.reasons) scheduleLayout(pending.page, reason);
}

// The last premium logged per quote, tab and carrier (notePremium).
const premiumsSeen = new Map();

// `reason`: given for a fill's capture; one asked for by page changes says its reasons when it's
// logged, since later changes may have handed it theirs.
async function captureLayout(job, reason) {
  const why = () => reason ?? [...job.reasons].sort().join('+');
  job.waitsForFill = false;
  if (!jobCurrent(job) || job.carrier.practice || superseded(job)) return;
  // A fill started while this page change's capture was queued: reading now could catch the page
  // half filled. It waits for the fill again, as it did before it was queued.
  const fillStarted = () => job.generation !== undefined && state.filling;
  if (fillStarted()) return waitForFill(job);
  const { tabId, carrier, page } = job;
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [buildPlan(state.intake.record, carrier, state.active), redactionTerms(state.intake.record)]);
    if (!jobCurrent(job) || superseded(job)) return;
    if (fillStarted()) return waitForFill(job);
    // The page actually read, as the page itself names it: the tab's address in the panel can
    // lag behind a navigation, and the next page must never be logged under this one's name.
    const top = results.map((r) => r.result).find((f) => f?.isTopFrame);
    if (top?.page !== page) return;
    // On a one-address application, which step (Insured Info, Vehicles, …): otherwise every step
    // would look like one page whose questions come and go. Only as one of the carrier's step
    // names (knownStep), like fill and field-change events: a heading can name the insured, and
    // the tab may still show the previous client's quote. Any other heading: no step.
    const step = carrier.layoutSteps ? knownStep(carrier, top.step) : undefined;
    // A stop step (GEICO's Payment Information, MVR & CLUE) is the agent's alone: no layout of it,
    // whose labels and messages may repeat payment or report details. By its title too, since the
    // kit reads no step when the progress bar and the title disagree.
    const stopTitle = Object.keys(carrier.stopSteps ?? {}).some((n) => String(top.title ?? '').toLowerCase().includes(n.toLowerCase()));
    if ((step && carrier.stopSteps?.[step]) || stopTitle) return;
    const buttons = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.buttons ?? []))];
    noteStopScreen(job, step, buttons);
    // The premium the page quotes, logged when it changed (src/premium.js; not awaited).
    if (premiumHere(carrier.id, page, step)) notePremium({ key: `${job.session}|${tabId}|${carrier.id}`, step: step ?? null, seen: premiumsSeen,
      read: async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => document.body?.innerText ?? '' }))[0]?.result,
      log: (e) => { if (!jobCurrent(job)) return false; usage.log({ carrier: carrier.id, page, view: viewOf(tabId, page, carrier), ...e }); return true; } });
    // What the page said about the answers (validation, errors, help), as pagekit's capture reads
    // and redacts it: the carrier's own wording of a refusal, which no other event carries.
    const messages = [...new Set(results.map((r) => r.result).filter(Boolean).flatMap((f) => f.messages ?? []))].slice(0, 40);
    const fields = results.map((r) => r.result).filter(Boolean).flatMap((f) => f.controls).map((c) => {
      // Agency staff lists (agent of record, agent/producer codes) aren't page structure.
      const staff = /agent|producer/i.test(c.label ?? '');
      return {
        q: c.q ?? null, ref: c.ref ?? null, row: /^\d{1,3}_\d{1,3}$/.test(c.row ?? '') ? c.row : null, kind: c.kind, type: c.type, label: c.label, required: c.required, section: c.section,
        // Element ids (stable ones only) and data-ids: how id-based rules (AmWINS) find the field.
        id: c.id && !/\d{5,}|ext-|-inputEl$/.test(c.id) ? c.id : null, dataId: c.dataId ?? null, name: c.name ?? null,
        options: c.options?.length && !staff ? c.options : undefined,
        optionsTruncated: c.optionsTruncated, mapped: c.wouldFill ?? null,
        // The choice picked now and whether a box has something in it: which answers were on the
        // page when follow-up questions appeared. Only a pick that is one of the captured choices
        // (or a checkbox's state): an editable dropdown's text may be typed or half-searched.
        selected: !staff && c.selected && (c.kind === 'checkbox' || (c.options ?? []).includes(c.selected)) ? c.selected : undefined,
        pageHasValue: c.pageHasValue,
      };
    });
    // Compared with the last layout logged for this page in this quote. Only the structure
    // counts: the questions, their choices and which are required. Answers are in the change
    // events; counting them would log a layout per answer. Yes, No, then Yes again on a
    // question that shows a follow-up logs three layouts. A field renamed under the same number
    // (its data-model name) is a change too: that's the evidence of a carrier rename.
    const shape = fields.map((f) => [f.q ?? f.label, f.ref, f.label, !!f.required, f.options ?? [], !!f.optionsTruncated]);
    // Messages too: the same questions with a new error on them is a page worth recording.
    const signature = await sha256Hex(JSON.stringify(messages.length ? [shape, messages] : shape));
    if (!jobCurrent(job) || superseded(job)) return;
    // Per quote tab too: each tab keeps its own quote state (refreshTab).
    const scope = `${job.session}|${tabId}|${carrier.id}|${editScope(page, carrier, step)}|${step ?? ''}`;
    // An empty page counts only when questions went away (an answer hid the last one) or a message
    // appeared: a fill or an arrival that finds nothing is a page still loading, or one without questions.
    if (!fields.length && !why().split('+').some((r) => r === 'removed' || (r === 'messages' && messages.length))) return;
    if (state.lastLayouts.get(scope) === signature) return;
    state.lastLayouts.set(scope, signature);
    const r = state.intake.record;
    const context = {
      state: r.garaging?.state ?? null,
      businessClass: r.operations.businessClass,
      vehicleTypes: [...new Set(r.vehicles.map((v) => v.type).filter(Boolean))],
      trailers: r.trailers.length > 0,
      drivers: r.drivers.length,
      vehicles: r.vehicles.length,
      coverages: Object.entries(r.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    };
    usage.log({ type: 'page_layout', carrier: carrier.id, page, view: viewOf(tabId, page, carrier), step, reason: why(), context, fields, buttons, ...(messages.length ? { messages } : {}) });
  } catch (e) {
    // A capture overtaken by a later change (a redraw can make its read fail) hands its reasons
    // on instead of reporting a failure for a page that is being captured anyway.
    if (jobCurrent(job) && !superseded(job)) layoutFailed(job, why(), layoutErrorKind(e));
  }
}

// A screen that is the agent's (carrier `stopButtons`: GEICO's "Add USDOT Number / Skip", W43-27),
// or the carrier's stop (`stopped`: GEICO's referral, W44-04), known by a button only it shows, as a
// layout reads the page: said above the page's answers while the tab shows it (showStopPage: a quiet
// card, or red for a `stopped` one), its arrival logged as a fill run that stopped, as a stop step's is,
// and nothing filled, clicked or asked of the AI there (stopNoteFor). A layout read without it, a
// move to a step or a new document (noteStep, the page_view arrival) ends it; a question or list
// GEICO draws while the screen is up doesn't (review of #141).
function noteStopScreen({ tabId, carrier, page }, step, buttons) {
  const name = stopScreen(carrier, buttons);
  const was = state.stopScreens.get(tabId);
  if (name === (was?.name ?? null) && (!name || was.page === page)) return;
  if (name) state.stopScreens.set(tabId, { name, page }); else state.stopScreens.delete(tabId);
  if (name) usage.log(...fillEvents([{ fields: 0, blockers: [`stop: ${name}`] }], { carrier: carrier.id, page, view: viewOf(tabId, page, carrier), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text, step }));
  if (tabId === state.tab?.id) renderSite();
}

function waitForFill(job) {
  job.waitsForFill = true;
  state.layoutPending = job;
  clearTimeout(state.layoutTimer);
  state.layoutTimer = setTimeout(() => layoutWhenQuiet(job), LAYOUT_DELAY_MS);
}

// A layout that couldn't be read: counted for the panel, and logged once per quote, page and kind
// of failure, so it shows up in the review instead of just missing.
function layoutFailed({ tabId, carrier, page }, reason, error) {
  state.layoutErrors++;
  // Per quote tab, as layouts are: each tab is its own quote.
  const once = `${usage.currentSession()?.id}|${tabId}|${page}|${error}`;
  if (state.layoutErrorsLogged.has(once)) return;
  state.layoutErrorsLogged.add(once);
  usage.log({ type: 'layout_error', carrier: carrier.id, page, view: viewOf(tabId, page, carrier), reason, error });
}

// Layouts as the page changes, whether or not anything is filled: on arrival, when questions
// appear or go away, after an answer changes (which can change another question's choices or
// make it required without adding a question), and when the agent picks another vehicle or
// driver. Waits for the page to be quiet after the last change: each change starts a new wait,
// taking over the reasons of the one before on the same page (whose run, if under way, then stops
// itself); a change elsewhere just replaces it. A fill logs its own layout when it ends.
const LAYOUT_DELAY_MS = 1200;
function scheduleLayout(page, reason) {
  // Only on the carrier's quote pages, named for it: never a portal, account or search page,
  // whose text the intake's redaction may not cover.
  const quotePages = state.tab?.carrier?.layoutUrl ?? state.tab?.carrier?.autoFillUrl;
  if (!state.intake || !state.tab?.carrier || state.tab.carrier.practice || !quotePages?.test(state.tab.url ?? '')) return;
  if (state.layoutHold && !state.layoutReadyTabs.has(state.tab.id)) return;
  const job = { ...layoutJob(page), generation: ++state.layoutGeneration, reasons: new Set([reason]) };
  const before = state.layoutPending;
  if (before && sameLayoutScope(before, job)) before.reasons.forEach((r) => job.reasons.add(r));
  state.layoutPending = state.layoutLatest = job;
  clearTimeout(state.layoutTimer);
  state.layoutTimer = setTimeout(() => layoutWhenQuiet(job), LAYOUT_DELAY_MS);
}

// Another intake loaded or the client cleared: a capture still waiting is for the old quote.
function cancelLayouts() {
  clearTimeout(state.layoutTimer);
  state.layoutPending = null;
}

// ...and the tabs still show whatever they showed: maybe the previous client's quote, whose
// text the new intake's redaction doesn't cover. No layouts from them until they move on.
function holdLayouts() {
  state.layoutHold = true;
  state.layoutReadyTabs = new Set();
  state.layoutNewTabs = new Set();
  // What was kept for the previous quote's layouts is no use any more.
  state.lastLayouts = new Map();
  // Nor is the previous client's last fill: a problem report must not name it.
  state.lastRuns = new Map();
  state.layoutErrorsLogged = new Set();
  // Nor a stop screen read for the previous client (its note names their USDOT number).
  state.stopScreens = new Map();
}

async function layoutWhenQuiet(job, tries = 0) {
  // Not replaced by a later change and still its quote, tab, page and vehicle/driver. Work that
  // isn't live only drops itself. While a fill runs (here or in another tab, and it may fail
  // without logging a layout), the capture waits for it rather than counting on it.
  const live = () => state.layoutPending === job && jobCurrent(job);
  const drop = () => { job.done = true; if (state.layoutPending === job) state.layoutPending = null; };
  const reason = () => [...job.reasons].sort().join('+');
  const afterFill = () => { state.layoutTimer = setTimeout(() => layoutWhenQuiet(job, tries), LAYOUT_DELAY_MS); };
  if (!live()) return drop();
  if (state.filling) return afterFill();
  let busy;
  try {
    busy = (await runKit(job.tabId, job.carrier, () => globalThis.__raterKit.busy())).some((r) => r.result);
  } catch (e) {
    // Couldn't ask the page: the same as a layout that couldn't be read, unless it moved on.
    if (live()) layoutFailed(job, reason(), layoutErrorKind(e));
    return drop();
  }
  if (!live()) return drop();
  if (state.filling) return afterFill();
  if (busy) {
    // Still loading (an answer's server round trip): look again shortly, a few times at most.
    // A page still busy after that (about eight seconds in all) is counted like one that couldn't
    // be read: nothing else may ask for its layout again.
    if (tries < 6) state.layoutTimer = setTimeout(() => layoutWhenQuiet(job, tries + 1), LAYOUT_DELAY_MS);
    else {
      layoutFailed(job, reason(), 'page busy');
      drop();
    }
    return;
  }
  state.layoutPending = null;
  // No reason given (null, not a fill's): the job says its own when it's logged.
  await recordLayout(job.page, null, job);
}

// The maps of the tab a fill was about: the panel's own while that tab is in front, else the
// session kept for it (refreshTab), made when there is none, so the bookkeeping of a fill whose
// results come back after the agent moved to another tab never lands on that other tab (audit
// 2026-10-08, finding 5).
function tabMaps(tabId) {
  if (!Number.isInteger(tabId) || state.tab?.id === tabId) return state;
  let saved = state.tabSessions.get(tabId);
  if (!saved) {
    saved = { filled: new Map(), labels: new Map(), choices: new Map(), autoPages: new Set(), autoPaused: false, unreadRetried: false, triedAgain: null,
      agentKeys: new Map(), doneActions: new Set(), unitForms: { vehicles: {}, drivers: {}, trailers: {} }, unitShown: null, visitedPages: new Set(), doneSteps: new Set(), assistPage: null, unitNamed: null, active: firstUnits() };
    state.tabSessions.set(tabId, saved);
  }
  return saved;
}

// Bookkeeping of a fill's results, for the tab, carrier and page the fill was about (fillContext;
// `scope`: the page's edit scope as the fill saw it, `editScope`, except where one address holds
// every step and form (formScoped); `active`: the vehicle, driver and trailer its plan was for;
// `auto`: an automatic fill's), never the tab in front now.
/** @param {FillReport[]} frames */
function rememberFill(frames, { tabId = state.tab?.id, carrier = state.tab?.carrier, page = pageOf(state.tab?.url), scope = editScope(page, carrier), active = state.active,
  intake = state.intake, revision = state.intakeRevision, auto = false } = {}) {
  const maps = tabMaps(tabId);
  if (state.intake && !state.intake.ntlAdded && frames.some((f) => (f.actions ?? []).some((a) => a.id === 'addNtl'))) {
    state.intake.ntlAdded = true;
    save();
  }
  // The intake unit the form named (pagekit unitNamed), for the mark once its list comes back.
  const named = frames.find((f) => f.unitNamed)?.unitNamed;
  maps.unitNamed = named ? { ...named, page } : null;
  const unitOk = (u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id;
  // Where one address holds every step and unit form (formScoped: GEICO): the form the page shows
  // now, held (pagekit unitHeld, the one the agent has to look at) or else filled (unitForm), with
  // the step it is on. The agent's edits there are scoped by it (editScope). A unit step that shows
  // none (its form closed, or the owner check) is noted with no form; any other step leaves it as
  // it was, and so does a fill that read nothing (the page never settled, Stop): the form may still
  // be there.
  const scoped = formScoped(carrier);
  const step = scoped ? knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey) : undefined;
  if (scoped) {
    const held = frames.findLast((f) => unitOk(f.unitHeld));
    const frame = held ?? frames.findLast((f) => unitOk(f.unitForm));
    if (frame) {
      const { list, id } = held ? frame.unitHeld : frame.unitForm;
      maps.unitShown = { step: knownStep(carrier, frame.stepKey), list, id, held: !!held };
    } else if (step && (carrier.vehicleSteps?.includes(step) || carrier.driverSteps?.includes(step)) && frames.some((f) => f.fields > 0)) maps.unitShown = { step, list: null, id: null, held: false };
  }
  // The agent's edits during the fill. Where every step and form shares the address, under the
  // step the fill read and the form it ended on (just noted), not the scope it began with: the
  // agent may have moved on meanwhile. A step the kit couldn't read: the page's, left alone by
  // every fill.
  const editedIn = scoped ? editScope(page, carrier, step ?? null, { active, shown: maps.unitShown }) : scope;
  const keys = maps.agentKeys.get(editedIn) ?? new Set();
  for (const key of frames.flatMap((f) => f.protectedKeys ?? [])) keys.add(key);
  maps.agentKeys.set(editedIn, keys);
  persistAgentKeys(tabId, maps.agentKeys);
  // A step the kit couldn't read (pagekit stepUnread: GEICO's progress bar and title disagree for a
  // moment right after Next) pauses nothing: an automatic fill there is tried once more shortly,
  // and not again until a fill reads a step. A fill the agent asked for isn't retried.
  if (frames.some((f) => f.halted && !f.stepUnread)) {
    maps.autoPaused = true;
    if (maps === state) {
      state.autoPending = false;
      clearTimeout(state.autoTimer);
      state.autoDrawn = null;
    }
  }
  if (frames.some((f) => f.fields > 0 && knownStep(carrier, f.stepKey))) maps.unreadRetried = false;
  else if (auto && !maps.unreadRetried && frames.some((f) => f.halted && f.stepUnread)) {
    maps.unreadRetried = true;
    setTimeout(() => {
      if (fillCurrent({ tabId, intake, revision }) && pageOf(state.tab?.url) === page && state.unreadRetried) scheduleAutoFill(page);
    }, 1500);
  }
  // A page the fill found still drawing (pagekit notDrawn: no question yet where the plan has
  // some, W43-42: Progressive's Business Owner Info, 0 fields, "No questions found", then a
  // 29-second fill), or done with no Continue to click yet (advanceDue, W43-40: a list page still
  // loading as the fill ended), is filled once more in a moment, once per page and step. Its
  // report says nothing until then (`retrying`, renderReport). Not a page the top frame has judged:
  // Continue held for the agent's check, with a frame that found none of the page's questions
  // (Progressive's hidden frame; live recording, 2026-10-24: a fill again after every held fill).
  const where = `${page}|${knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey) ?? ''}`;
  const due = !frames.some((f) => f.halted || f.advanced || f.held) && frames.some((f) => f.notDrawn || f.advanceDue);
  let retrying = false;
  if (due && maps.triedAgain !== where && $('auto-followups').checked && !maps.autoPaused) {
    maps.triedAgain = where;
    retrying = true;
    setTimeout(() => {
      if (fillCurrent({ tabId, intake, revision }) && pageOf(state.tab?.url) === page) scheduleAutoFill(page);
    }, 1500);
  } else if (!due) maps.triedAgain = null;
  const finish = carrier?.finishedBy;
  const finishStep = knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey);
  const finishedBefore = !!finish && maps.doneActions.has(finish) && !maps.doneActions.has(`${finish}:changed`);
  for (const id of frames.flatMap((f) => f.invalidatedActions ?? [])) maps.doneActions.delete(id);
  for (const a of frames.flatMap((f) => f.actions ?? [])) { maps.doneActions.add(a.id); maps.doneActions.delete(`${a.id}:changed`); }
  const finishClicks = finish ? frames.flatMap((f) => f.actions ?? []).filter((a) => a.id === finish) : [];
  // The quote's finishing action clicked by this fill (GEICO's Print Quote Proposal, Progressive's
  // Print, Email, Fax), not done before, or changed or re-armed since (`:changed`, or this fill's own
  // answer on the step: pagekit invalidatedActions, Progressive's Rates), and the fill's report the
  // quote done as Review page says it (quoteFinished: nothing left for the agent, not stopped short,
  // no AI pick pending): the chime (noteQuoteDone). The tab's done actions say it, so New quote, Clear
  // and a panel opened again follow (the review of PR #171).
  if (finishClicks.some((a) => !a.alreadyShown) && (!finishedBefore || frames.some((f) => f.invalidatedActions?.includes(finish)))) {
    const report = { fields: frames.reduce((n, f) => n + (f.fields ?? 0), 0), left: itemsLeft(frames).length,
      waiting: frames.reduce((n, f) => n + (f.blocked?.length ?? 0), 0), halted: frames.some((f) => !!f.halted) };
    if (quoteFinished(carrier, report, page, finishStep, maps.doneActions) && !pendingAi(tabId, page).length) noteQuoteDone();
  }
  // A rater whose quote ends at a step (`finishedAt`, AmWINS's declaration): the first fill there that
  // leaves the agent nothing but its own items (the declaration, then Submit) is the quote done, kept
  // with the tab's done actions (so once a quote: New quote and Clear empty them), with the chime.
  const at = carrier?.finishedAt;
  if (at && !maps.doneActions.has(at.id)) {
    const left = itemsLeft(frames);
    const report = { fields: frames.reduce((n, f) => n + (f.fields ?? 0), 0), left: left.length, otherLeft: left.filter((x) => !finishLeftOk(carrier, x)).length,
      waiting: frames.reduce((n, f) => n + (f.blocked?.length ?? 0), 0), halted: frames.some((f) => !!f.halted) };
    if (quoteFinished(carrier, report, page, finishStep, maps.doneActions) && !pendingAi(tabId, page).length) {
      maps.doneActions.add(at.id);
      noteQuoteDone();
    }
  }
  // An answer this fill put in on the quote's finishing step, or an edit of the agent's it kept, after
  // the finishing action was clicked, and that action not clicked again: the printed proposal is no
  // longer the quote on the page (noteChangedAfterDone; GEICO's Recalculate and Print are clicked once).
  if (finish && !finishClicks.length && frames.some((f) => (f.filled ?? []).some((x) => !x.otherStep) || f.protectedKeys?.length)) {
    noteChangedAfterDone(carrier, page, finishStep, tabId);
  }
  persistDoneActions(tabId, maps.doneActions);
  // The unit form this fill answered (pagekit unitForm: its marker's element name, new with every
  // form GEICO draws) is now that vehicle's, driver's or trailer's: a follow-up fill never types
  // this unit's answers into the next unit's form, drawn at the same address (survey 2026-10-20).
  // The agent's edits filed under the form itself (made while it was held, changeScopes) become the
  // unit's too: GEICO draws a new form, a new marker, when the agent opens a saved vehicle again.
  const forms = frames.map((f) => f.unitForm).filter(unitOk);
  if (forms.length) {
    maps.unitForms ??= { vehicles: {}, drivers: {}, trailers: {} };
    let copied = false;
    for (const { list, id } of forms) {
      const index = active?.[list] ?? 0;
      (maps.unitForms[list] ??= {})[id] = index;
      const own = scoped ? maps.agentKeys.get(`${page}|f:${id}`) : null;
      if (!own?.size) continue;
      const unit = unitScope(page, list, index);
      const keys = maps.agentKeys.get(unit) ?? new Set();
      for (const key of own) keys.add(key);
      maps.agentKeys.set(unit, keys);
      copied = true;
    }
    persistUnitForms(tabId, maps.unitForms);
    if (copied) persistAgentKeys(tabId, maps.agentKeys);
  }
  for (const x of frames.flatMap((f) => f.filled)) maps.filled.set(x.key, { path: x.path, shown: x.shown, standard: isStandard(x, 'filled') });
  // The quote's state this fill picked (AmWINS' risk state): the recorder is paused while filling.
  const quoteKey = carrier?.quoteState?.key;
  const pickedState = quoteKey && frames.flatMap((f) => f.filled).find((x) => x.key === quoteKey);
  if (pickedState) noteQuoteState(tabId, carrier.id, stateCode(pickedState.shown));
  for (const [key, label] of frames.flatMap((f) => f.labels ?? [])) if (label) maps.labels.set(key, label);
  // Kept from every fill: a searched combo's list differs from one fill to the next.
  for (const [key, options] of frames.flatMap((f) => f.choices ?? [])) {
    const seen = maps.choices.get(key) ?? new Set();
    for (const o of options) seen.add(o);
    maps.choices.set(key, seen);
  }
  return retrying;
}

function renderSite() {
  const site = $('site');
  const logo = $('site-logo');
  const caption = $('site-caption');
  const carrier = state.tab?.carrier;
  // No URL means the browser isn't letting the extension see this site (site access / permissions).
  const noAccess = inExtension && state.tab && !state.tab.url;
  // Retain the carrier text as an image-error fallback and for the panel harness.
  site.textContent = !inExtension ? 'Preview only' : carrier ? carrier.name : noAccess ? 'No access to this page' : 'Not a rater page';
  // On a rater page, its logo, page and place in the quote; elsewhere the panel's own name (the
  // dock says what to open).
  $('carrier-line').hidden = !carrier;
  $('brand').hidden = !!carrier;
  // Where the tab is in the quote: its step, "Step 3 of 7" and a bar (carriers.js quoteProgress).
  const page = pageOf(state.tab?.url);
  const progress = carrier ? quoteProgress(carrier, page, state.tabSteps.get(state.tab.id)) : null;
  $('site-step').hidden = !progress;
  $('site-step').textContent = progress ? `${progress.name} page` : '';
  $('site-count').hidden = !progress;
  $('site-count').textContent = progress ? `Step ${progress.index + 1} of ${progress.count}` : '';
  const filledHere = reportShown() && !!state.reportFor.fields;
  $('site-track').hidden = !progress;
  $('site-track').replaceChildren(...(progress ? (carrier.quoteSteps ?? []).map((step, i) => h('span', {
    title: step.name, class: i < progress.index ? 'done' : i === progress.index ? `here${filledHere ? ' filled' : ''}` : null,
  })) : []));
  caption.textContent = [
    carrier ? (carrier.practice ? 'Practice page' : progress ? null : 'Commercial auto') : null,
    carrier && state.tab?.background ? 'In background' : null,
  ].filter(Boolean).join(' · ');
  caption.hidden = !caption.textContent;
  const paths = {
    progressive: 'assets/raters/progressive.svg',
    geico: 'assets/raters/geico.gif',
    amwins: 'assets/raters/amwins.svg',
  };
  const src = paths[carrier?.id] || null;
  const title = state.tab?.background ? 'Working on the quote tab. Go back to it to see the marks.' : '';
  caption.title = title;
  logo.alt = carrier?.name || '';
  logo.title = title;
  if (logo.getAttribute('src') !== src) {
    // Use a fresh image when the carrier changes so an old load event cannot hide the fallback.
    const nextLogo = logo.cloneNode(false);
    nextLogo.removeAttribute('src');
    nextLogo.alt = carrier?.name || '';
    nextLogo.hidden = true;
    site.hidden = false;
    nextLogo.onload = () => {
      if (!nextLogo.isConnected) return;
      nextLogo.hidden = false;
      site.hidden = true;
    };
    nextLogo.onerror = () => {
      if (!nextLogo.isConnected) return;
      nextLogo.hidden = true;
      site.hidden = false;
    };
    logo.replaceWith(nextLogo);
    if (src) nextLogo.src = src;
  } else if (!src) {
    logo.hidden = true;
    site.hidden = false;
  }
  // Practice pages aren't recorded: don't say they are.
  $('recording').hidden = !state.intake || !!carrier?.practice;
  site.title = title;
  site.classList.toggle('on', !!carrier);
  $('capture').disabled = !(inExtension && carrier);
  // "Let me look before Continue" is about the panel's Continue: off with it.
  $('check-continue').disabled = !$('auto-advance').checked;
  showCarrierNote();
  // Another carrier's site shows or hides the current-carrier check (checkShown); only then, so a
  // page change doesn't redraw a check the agent is typing in.
  const checksFor = carrier?.id ?? null;
  if (state.intake && state.checksCarrier !== checksFor) { state.checksCarrier = checksFor; renderWarnings(); }
  showStopPage();
  showStateNote();
  showReviewMode();
  renderSteps();
}

// Shows an earlier page's answers (its report key), read-only, in place of this page's; null goes
// back to this page's. Nothing on either page changes.
function showPast(key) {
  state.pastKey = key && state.reports.get(key)?.tabId === state.tab?.id ? key : null;
  renderSteps();
  if (state.pastKey) announce(`Showing the answers of ${reportTitle(state.reports.get(state.pastKey))}, as filled.`);
}

// Puts the report of the page in front into the page view, keeping the one it replaces with its
// own nodes, so its buttons and the AI's cards work again when its page is back. Returns it.
function showReport() {
  const key = currentReportKey();
  const shown = state.reportFor;
  if ((shown?.key ?? null) === key) return shown;
  if (shown) shown.nodes = [...$('report').childNodes];
  const next = key ? state.reports.get(key) ?? null : null;
  // Kept while another page was in front: said in the page view (renderSteps).
  if (next?.nodes) next.restored = true;
  $('report').replaceChildren(...(next?.nodes ?? []));
  state.reportFor = next;
  return next;
}
function reportShown() { return !!showReport(); }

// A fill's report for its page: shown when that page is in front, else kept until it is.
function putReport(entry, nodes) {
  showReport();
  // The report it replaces: its list taken down (report-view.jsx).
  const old = state.reports.get(entry.key);
  if (old && old !== entry) old.unmountRows?.();
  state.reports.set(entry.key, entry);
  if (entry.key === currentReportKey()) {
    $('report').replaceChildren(...nodes);
    state.reportFor = entry;
  } else {
    entry.nodes = nodes;
  }
}

// Forgets the reports `drop` picks (all: a new or cleared client; a closed tab's; one page's).
function dropReports(drop = () => true) {
  for (const [key, entry] of state.reports) {
    if (!drop(entry)) continue;
    state.reports.delete(key);
    entry.unmountRows?.();
  }
  forgetKeptReports(drop);
  if (state.reportFor && state.reports.get(state.reportFor.key) !== state.reportFor) {
    state.reportFor = null;
    $('report').replaceChildren();
  }
}

// A fill that couldn't finish ('error'), or found nothing to do ('notice'), said above its page's
// answers (a report is made for a page that has none), where Fill this page retries it. `ctx`: the
// fill's tab, page, carrier and unit.
function fillProblem(ctx, text, kind = 'error') {
  const key = reportKey(ctx.tabId, ctx.page, ctx.carrier, ctx.active ?? state.active);
  if (!key) return;
  showReport();
  const entry = state.reports.get(key);
  if (entry) Object.assign(entry, { error: null, notice: null, [kind]: text });
  else putReport({ key, tabId: ctx.tabId, page: ctx.page, at: Date.now(), [kind]: text }, []);
  renderSteps();
}

// What's left for the agent on the report shown: its items not settled since (answered on the
// page or here, marked done, an AI answer the agent accepted). The steps, the filters and the dock
// follow.
function recount() {
  const entry = state.reportFor;
  if (!entry?.fields) return;
  // A question gone from the page since (checkItems) isn't left: it holds nothing.
  const { left, otherLeft } = leftOf(entry.list);
  entry.otherLeft = otherLeft;
  if (left === entry.left) return;
  // Settled since the fill: the panel's Continue is a click away now, never on its own.
  entry.settled = !left && entry.left > 0;
  entry.left = left;
  renderSteps();
  announce(left ? `${left} left for you on this page.` : 'Nothing is left for you on this page.');
}

// Polite announcements for screen readers: fill results and counts that change.
function announce(text) {
  const live = $('announce');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
}

// The three steps under the client's name: what each says about the intake and the page in front,
// and which one's view is shown (state.steps, drawn by steps-view.jsx); then the page view (the answers going in, or the last fill's, with
// their filters) and the dock. Steps 2 and 3 show the last fill of the page in front.
function renderSteps() {
  // Pop out or Dock: never while a fill runs.
  $('pop-out').hidden = !inExtension || popped;
  $('dock-back').hidden = !popped;
  $('pop-out').disabled = $('dock-back').disabled = !!state.filling;
  if (!state.intake) { renderDock(); return; }
  // New quote with this intake: not while answers go in (the fill's report would be dropped under it).
  $('new-quote').disabled = !!state.filling;
  // The unit pickers follow the page or step in front (unitListsHere).
  renderPickers();
  const { warnings, done } = state.intake;
  const open = warnings.filter((w, i) => checkShown(w) && !done.includes(i)).length;
  const carrier = state.tab?.carrier;
  const page = pageOf(state.tab?.url);
  const onRater = inExtension && !!carrier;
  const stopped = !!stopNoteFor(carrier, page);
  const report = showReport();
  // The fill running on this tab: its answers in so far, in place of the report.
  // A quiet automatic fill (no rows yet) leaves the report in place, as the live list and the dock do.
  const filling = state.filling && !!state.fillingFor && state.fillingFor.tabId === state.tab?.id && (!state.fillingFor.auto || !!state.fillingFor.rows?.length);
  const filled = !filling && !!report?.fields;
  // Why the last fill didn't finish, or what it found instead of questions (a portal page).
  const error = filling ? null : report?.error ?? null;
  const notice = filling || error ? null : report?.notice ?? null;
  const left = filled ? report.left ?? 0 : 0;
  const steps = {};
  const step = (id, { tone = '', note, current }) => { steps[id] = { tone, note, current: !!current }; };
  // 1. Intake.
  step('check', { tone: open ? 'warn' : 'done', note: open ? `${open} to check` : 'All checked', current: state.view === 'check' });
  // 2. Fill page: the page in front's.
  step('fill', {
    tone: !onRater ? '' : error || (stopped && !filled) ? 'bad' : filled ? 'done' : 'active',
    note: !onRater ? 'Open a rater' : filling ? `Filling… ${state.fillingFor.filled ?? 0} in` : error ? 'Didn’t finish'
      : filled ? `${report.filled} filled${report.auto ? ' automatically' : ''}` : stopped ? 'Stopped' : 'Ready to fill',
    current: state.view === 'page' && !filled,
  });
  // 3. Review page: what's left for the agent on it, and Continue; "Quote done" where the quote
  // ends (quoteFinished).
  const finished = filled && quoteFinished(carrier, report, page) && !pendingAi(state.tab.id, page).length;
  step('confirm', {
    tone: !filled ? '' : finished || report.advanced ? 'done' : 'active',
    note: !filled ? 'After the fill' : finished ? 'Quote done' : report.advanced ? 'Continued' : left ? `${left} need${left === 1 ? 's' : ''} you` : 'All answered',
    current: state.view === 'page' && filled,
  });
  state.steps = steps;
  // The page view: a rater to open, what's wrong about the last fill, the answers.
  $('fill-waiting').hidden = onRater;
  $('fill-waiting-text').textContent = !inExtension ? 'Filling works only in the Chrome extension.'
    : state.tab && !state.tab.url ? 'The extension can’t read this page. Allow it on this site (toolbar icon or site access), then reload.'
      : 'Open the client’s quote on one of these raters.';
  const problem = $('fill-error');
  problem.hidden = !error && !notice;
  problem.replaceChildren(...(error ? [issueCard({ title: 'Filling didn’t finish', text: error, role: 'alert' })]
    : notice ? [issueCard({ tone: 'quiet', title: notice })] : []));
  // Pages filled earlier on this tab (the page menu), and the one picked, shown read-only in place
  // of this page's: never while a fill runs on the tab.
  const earlier = onRater && !filling ? earlierReports() : [];
  const past = earlier.find((e) => e.key === state.pastKey) ?? null;
  if (!past) state.pastKey = null;
  if (!past) $('past').replaceChildren();
  else if (state.pastNodes !== past.nodes) $('past').replaceChildren(...past.nodes);
  state.pastNodes = past?.nodes ?? null;
  const at = (entry) => new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('feed').hidden = !onRater || (!filling && !filled && !earlier.length);
  $('feed-title').textContent = filling ? 'Filling now' : earlier.length ? 'Answers' : 'Answers on this page';
  const menu = $('page-menu');
  menu.hidden = !earlier.length;
  if (earlier.length) {
    const keys = JSON.stringify(earlier.map((e) => e.key));
    if (menu.dataset.keys !== keys) {
      menu.replaceChildren(h('option', { value: '' }, 'This page'), ...earlier.map((e) => h('option', { value: e.key }, reportTitle(e))));
      menu.dataset.keys = keys;
    }
    menu.value = past?.key ?? '';
  }
  $('past').hidden = !past;
  $('past-head').hidden = !past;
  $('past-when').textContent = past ? `${reportTitle(past)} · filled ${at(past)} · view only` : '';
  $('report').hidden = !filled || !!past;
  $('report').dataset.filter = state.filter;
  const counts = listCounts(filled ? report.list : []);
  $('filters').hidden = !filled || !counts.all || !!past;
  for (const b of $('filters').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
    b.querySelector('span').textContent = String(counts[b.dataset.filter] ?? 0);
  }
  $('feed-empty').hidden = !!past || filling || (filled && (counts[state.filter] ?? 0) > 0);
  $('feed-empty').textContent = !filled ? 'This page isn’t filled yet.' : state.filter === 'needs' ? 'Nothing needs you on this page.' : 'Nothing here.';
  // What the tags and the rater page's marks mean: behind the i in the title.
  const keyHere = !filling && (filled || !!past);
  $('key-btn').hidden = !keyHere;
  $('key-btn').setAttribute('aria-expanded', String(keyHere && state.keyOpen));
  $('answer-key').hidden = !(keyHere && state.keyOpen);
  $('unmark').hidden = !filled || !!past;
  // A report kept while another page was in front may be out of date.
  const age = filled && !past && report.restored && report.at ? at(report) : null;
  $('report-age').hidden = !age;
  $('report-age').textContent = age ? `From the fill at ${age}. Fill again if the page changed.` : '';
  renderDock();
}

// The dock's word on a page the fill went through: whether Continue was clicked, is the panel's
// to click, or the agent's, and what is left before it. `settled`: what was left has been settled
// since the fill; the panel's Continue then waits for a fill again. `held`: the fill found the page
// done but held Continue for the agent's check ('check'), or the page changed after they clicked
// Looks right ('changed'). With "Let me look before Continue" on, Looks right takes the place of
// Fill again and continue.
function continueSaid({ advanced, filled = 0, left = 0, waiting = 0, covered = 0, page, settled, held, tabId }, carrier = state.tab?.carrier) {
  const holding = left || waiting;
  // A step the carrier's Continue is never clicked on (GEICO's Quote & Coverages: advance `steps`).
  const offSteps = !!carrier?.advance?.steps?.length && !carrier.advance.steps.includes(tabStep(carrier, tabId ?? state.tab?.id));
  const autoAdvance = !!carrier?.advance && $('auto-advance').checked && !carrier.advance.exceptPages?.includes(page) && !offSteps;
  const check = autoAdvance && !!$('check-continue')?.checked;
  const looks = { button: 'look-right', label: 'Looks right, continue' };
  const again = { alt: 'fill-again', altLabel: 'Fill this page again' };
  // Seen again once the agent went back to the page, or in a panel opened again (W43-39): it can be
  // filled again.
  if (advanced) return { phase: 'done', tone: 'good', eyebrow: 'Continued', title: 'Continue clicked', sub: `Clicked “${advanced}” for you. Nothing is submitted or bound.`, ...again };
  if (holding) {
    const then = check ? 'Then check the answers and click Looks right. Never Bind or Submit.'
      : offSteps ? 'Then moving on is yours: nothing on this step is clicked for you.'
      : !autoAdvance ? (carrier?.advance && $('auto-advance').checked
        ? 'Then click Continue on this page yourself. Nothing is submitted or bound.'
        : 'Then click Continue yourself, and Fill this page on the next one.')
      : $('auto-followups').checked ? 'Then the panel continues to the next page. Never Bind or Submit.'
      : 'Then Fill this page again to continue. Never Bind or Submit.';
    // Buttons waiting on others (Progressive's bill plan before Recalculate): the fill clicks them
    // in turn, and a question one waits on is a row of its own.
    // Something open on the page over the button: never clicked in turn until it is closed.
    if (!left && covered) return { phase: 'needs', tone: 'warn', eyebrow: `${filled} filled`, title: 'Close what is open over the button', sub: 'Then fill again. Never Binds or Submits.', ...again };
    // Only buttons left: the main button is the fill that clicks them in turn (and the page's
    // Continue after them, where the panel may): nothing clicks them by itself (it read "The fill
    // clicks the rest in turn" with no button for it). With Let me look before Continue on, the fill
    // holds Continue for Looks right after them; a button it can't click isn't a row of the report.
    if (!left) {
      const continues = autoAdvance && !check;
      return { phase: 'waiting', tone: 'blue', eyebrow: `${filled} filled`, title: 'Buttons left to click',
        sub: continues ? 'Continue clicks the ones it can in turn, and the page’s Continue once none is left. Never Bind or Submit.' : then,
        button: 'fill', label: continues ? 'Continue' : 'Click them for me', go: 'continue', ...again };
    }
    return { phase: 'needs', tone: 'warn', eyebrow: `${filled} filled · ${left} need${left === 1 ? 's' : ''} you`,
      title: left === 1 ? 'Answer the last question' : `Answer ${left} questions`, sub: then, button: 'dock-next', label: 'Show the next one', ...again };
  }
  if (held === 'changed') return { phase: 'check', tone: 'warn', eyebrow: 'The page changed', title: 'Check the answers again', sub: 'The page changed. Check it, then continue.', ...looks };
  if (held || (check && settled)) return { phase: 'check', tone: 'good', eyebrow: 'All answered', title: 'Look over the answers, then continue', sub: 'Never Binds or Submits.', ...looks };
  if (offSteps) return { phase: 'yours', tone: 'good', eyebrow: 'All answered', title: 'Moving on is yours', sub: 'Nothing here is clicked for you. Never Binds or Submits.', ...again };
  if (!autoAdvance) {
    return { phase: 'ready-continue', tone: 'good', eyebrow: 'All answered', title: 'Ready for Continue', ...again,
      sub: carrier?.advance && $('auto-advance').checked ? 'Click Continue on this page yourself. Never Binds or Submits.' : 'Click Continue, then fill the next page.' };
  }
  // Nothing left and the page not moved on: the main button continues (a fill, which clicks the
  // page's Continue once nothing is left: W43-40). The same once the agent settled what was left,
  // on the page or here (`settled`): it read "Fill again and continue" then, for the same fill that
  // replaces nothing (the maintainer, 2026-10-23: "I update something manually and the button still
  // says Fill again").
  return { phase: 'ready-continue', tone: 'good', eyebrow: 'All answered', title: 'Ready for Continue', sub: 'Never Binds or Submits.', button: 'fill', label: 'Continue', go: 'continue', ...again };
}

// The page changed on the finishing step after the action was clicked (a limit on GEICO's Quote &
// Coverages after Print Quote Proposal; its Recalculate is clicked once a quote, so no fill re-rates or
// re-prints): the printed proposal is no longer the quote on the page, so it isn't "Quote done" (the
// review of PR #170). By the agent on the page (the recorder's field_changes), from the panel (their
// pick, an AI pick: the recorder is paused then), or by a fill that put an answer in or kept the
// agent's edit made during it without clicking the action (rememberFill). Marked with the tab's done
// actions (`<id>:changed`, kept with them); the action clicked again, by a fill or by the agent
// (agentHelperDone), lifts it. True when newly marked.
function noteChangedAfterDone(carrier, page, step, tabId = state.tab?.id) {
  const id = finishingAction(carrier, page, step);
  if (!id) return false;
  const { doneActions } = tabMaps(tabId);
  if (!doneActions?.has(id) || doneActions.has(`${id}:changed`)) return false;
  doneActions.add(`${id}:changed`);
  persistDoneActions(tabId, doneActions);
  return true;
}

// A short chime when the quote is done where TNI stops on the rater (the maintainer, 2026-10-25: "a
// ding when we finish the quote, not just one page"): when the finishing action is clicked on a tab
// where it wasn't done, or was changed or re-armed since (the tab's done actions): by the fill, whose
// report is then the quote done (rememberFill), or by the agent (agentHelperDone). So once a print:
// again after a change on the finishing step and another print, and on a new quote (New quote, Clear:
// the done actions go), not on the same quote printed again, in this panel or one opened again (they
// are kept). Off with Sound when the quote is done (Settings → Filling, `finish-sound`, saved on this
// computer as `finishSound`, never logged). The sound is the maintainer's pick (2026-10-25),
// sidepanel/sounds/quote-done.mp3, played with an audio element: no new permission. True when it was
// started.
function noteQuoteDone() {
  if (!$('finish-sound')?.checked) return false;
  return playChime();
}
// Chrome lets a page make sound once someone has clicked in it: the element is made and loaded on the
// agent's first click in the panel (wireUsage), so it is ready when the quote ends.
function unlockAudio() {
  try {
    if (!state.audio && typeof Audio === 'function') { state.audio = new Audio('sounds/quote-done.mp3'); state.audio.preload = 'auto'; }
  } catch { state.audio = null; }
  return !!state.audio;
}
function playChime() {
  if (!unlockAudio()) return false;
  try {
    state.audio.currentTime = 0;
    // Refused (no click in the panel yet) or unplayable: silent, never an error in the panel.
    state.audio.play()?.catch?.(() => {});
    return true;
  } catch { return false; }
}

// The dock: the one next thing to do, always in the same place under the panel, and its button.
// #dock[data-phase] names it, and data-report the fill it is about (the panel harness reads both).
function dockFor() {
  if (!state.intake) return { phase: 'start', eyebrow: 'Step 1 of 3', title: 'Add the client’s intake PDF', sub: 'The panel checks it and fills the rater.' };
  const { warnings, done } = state.intake;
  const open = warnings.filter((w, i) => checkShown(w) && !done.includes(i)).length;
  const checksSaid = state.view === 'check' && open ? `${open} intake item${open === 1 ? '' : 's'} not looked at yet. You can still fill.` : null;
  const carrier = state.tab?.carrier;
  if (!inExtension) return { phase: 'off', eyebrow: 'Preview', title: 'Filling works only in the Chrome extension' };
  if (!carrier) {
    return state.tab && !state.tab.url
      ? { phase: 'off', eyebrow: 'Next', title: 'The extension can’t read this page', sub: 'Allow it on this site (toolbar icon or site access), then reload.' }
      : { phase: 'off', eyebrow: 'Next', title: 'Open the client’s quote on a rater', sub: checksSaid ?? 'Progressive, GEICO or AmWINS.' };
  }
  const f = state.fillingFor;
  if (state.filling && f?.tabId === state.tab.id && (!f.auto || !!f.rows?.length)) {
    const last = f.rows?.at(-1);
    // The page hasn't answered for a while (watchFill): a message box open on it waits for the agent.
    if (f.unanswered) {
      return { phase: 'filling', tone: 'warn', progress: true, eyebrow: f.stopping ? 'Stopping' : `Filling · ${f.filled ?? 0} in`,
        title: 'The page isn’t answering', sub: 'If it shows a message box, answer it there. The fill goes on after.',
        button: 'fill-stop', label: f.stopping ? 'Stopping…' : 'Stop', disabled: !!f.stopping };
    }
    return { phase: 'filling', tone: 'blue', progress: true, eyebrow: f.stopping ? 'Stopping' : `Filling · ${f.filled ?? 0} in`,
      title: f.stopping ? 'Stopping after the answer going in now…' : f.phase && DOCK_PHASES.has(f.phase.name) ? `${phaseSaid(f.phase)[0]}…` : last ? `Just filled: ${last.label || 'an answer'}` : 'Reading the page…',
      sub: 'Keep this tab open.', button: 'fill-stop', label: f.stopping ? 'Stopping…' : 'Stop', disabled: !!f.stopping };
  }
  const page = pageOf(state.tab.url);
  const step = tabStep(carrier);
  // The carrier stopped the quote here (a stop page, or a stop screen marked `stopped`: GEICO's
  // referral, W44-04), or the step or screen is the agent's: nothing to press.
  if (stopNoteFor(carrier, page, step)) {
    const screen = step && carrier.stopSteps?.[step] ? null : state.stopScreens?.get(state.tab.id)?.name;
    if (carrier.stopPages?.[page] || carrier.stopButtons?.[screen]?.stopped) return { phase: 'stopped', tone: 'bad', eyebrow: `Stopped by ${carrier.name}`, title: 'Nothing to fill on this rater', sub: 'Nothing on this page was filled or clicked.' };
    return { phase: 'yours', eyebrow: 'This step is yours', title: `Finish ${screen ?? step ?? 'this step'} yourself`, sub: `Nothing on this ${screen ? 'screen' : 'step'} is filled or clicked.` };
  }
  // The tab's quote is for another state than the intake's: no fill until the agent says which.
  const issue = stateIssue();
  if (issue) {
    return { phase: 'hold', tone: 'bad', eyebrow: 'Check first', title: 'Sort out the state above', sub: `${issue.intake} answers fail on a ${issue.picked} quote.`,
      button: 'fill', label: 'Fill this page', disabled: true, alt: 'fill-anyway', altLabel: 'Fill anyway' };
  }
  // The carrier's portal pages outside a quote are never filled (fillPage).
  if (!onQuotePage()) return { phase: 'portal', eyebrow: 'Next', title: 'Open the client’s quote', sub: 'This is the portal. Filling starts on a quote page.' };
  const report = showReport();
  // On a one-address application (AmWINS) every step shares the address: "again" only once this
  // step has a report.
  const filledBefore = carrier.layoutSteps ? !!report?.fields : state.autoPages.has(page);
  const fill = { button: 'fill', label: filledBefore || report?.fields ? 'Fill this page again' : 'Fill this page' };
  if (report?.error) return { phase: 'error', tone: 'bad', eyebrow: 'Didn’t finish', title: 'Check the page, then fill again', sub: 'Your changes are kept.', ...fill };
  // The quote is done where TNI stops on this rater (quoteFinished): said, in place of "Moving on
  // is yours" or "Ready for Continue" on a page that is the end of the quote.
  if (report && quoteFinished(carrier, report, page, step) && !pendingAi(state.tab.id, page).length) {
    return { phase: 'finished', tone: 'good', eyebrow: 'Quote done', title: carrier.finishedAt?.said ?? carrier.finishedSaid ?? 'The quote proposal is printed',
      sub: carrier.finishedAt?.sub ?? `This is where TNI stops on ${carrier.name}. Nothing is submitted or bound.`, alt: 'fill-again', altLabel: 'Fill this page again' };
  }
  // A page the fill had no question for and left nothing on (a unit list with every unit on it):
  // Continue is next (W43-40: the dock offered Fill this page again on finished vehicle lists).
  if (report?.empty) return continueSaid({ ...report, tabId: state.tab.id }, carrier);
  if (report?.fields) {
    if (report.stopped) return { phase: 'stopped-fill', tone: 'warn', eyebrow: 'Stopped', title: `${report.filled} filled before you stopped`, sub: 'Fill again to finish. Your changes are kept.', button: 'fill', label: 'Fill this page again' };
    // AI picks waiting for approval hold Continue: approved (or confirmed) from here or their rows.
    const aiDock = state.aiDocks.get(`${state.tab.id}|${page}`);
    const ai = aiDock ? pendingAi(state.tab.id, page) : [];
    if (ai.length) {
      const waiting = ai.filter((x) => !x.rejected).length;
      const continues = aiDock.canContinue && (report.left ?? 0) <= ai.length;
      return { phase: 'ai', tone: 'ai', eyebrow: `AI picked ${ai.length} answer${ai.length === 1 ? '' : 's'}`,
        title: waiting ? 'Check the purple answers, then approve' : 'Confirm the page answer, or change it',
        sub: waiting < ai.length ? 'Continue waits until you confirm the page answer or change it.'
          : aiDock.canContinue ? 'Continue waits until you approve them.' : 'Check them (purple on the page), then approve.',
        button: 'ai-approve', label: waiting ? (continues ? 'Approve and continue' : `Approve ${waiting === 1 ? 'the AI pick' : `${waiting} AI picks`}`)
          : continues ? 'Confirm and continue' : 'Confirm the page answer' };
    }
    const said = continueSaid(report, carrier);
    // A question open now with others after it: the dock moves on past it.
    if (said.button === 'dock-next' && (report.left ?? 0) > 1 && (state.reportFor?.list ?? []).some((r) => r.type === 'need' && r.open && !r.settled)) said.label = 'Skip to the next one';
    return said;
  }
  // Nothing filled on this page yet: what the fill will and won't do here.
  const hint = state.tab.background ? 'Fills the quote tab in the background. Go back to it to review.'
    // GEICO: the units it adds with that setting on (unitLists, pickUnitToAdd), and Next only up to
    // Additional Business Info (advance `steps`).
    : $('auto-advance').checked && carrier.advance && carrier.unitLists ? 'Adds missing vehicles, trailers and drivers, and clicks Next up to Quote & Coverages. Never submits or binds.'
    : $('auto-advance').checked && carrier.advance ? 'Clicks Continue once nothing is left for you. Never submits or binds.'
    : 'Nothing is submitted. Review, then click Next yourself.';
  const progress = quoteProgress(carrier, page, state.tabSteps.get(state.tab.id));
  return { phase: 'ready', eyebrow: 'Next', title: progress ? `Fill the ${progress.name} page` : 'Fill this page', sub: checksSaid ?? hint, ...fill };
}

// What the dock says now (state.dock, drawn by steps-view.jsx): dockFor's word, hidden while Settings
// is open, with the fill it is about (`report`: none while one runs) and whether a fill runs, which
// holds its Fill (`busy`).
function renderDock() {
  const d = dockFor();
  state.dock = { ...d, hidden: state.settingsOpen, report: state.reportFor?.at && d.phase !== 'filling' ? String(state.reportFor.at) : '', busy: !!state.filling };
}

// The intake's current insurance is with the carrier the tab is on (util.js sameCarrier: GEICO or
// Progressive, misspelled or with a suffix; never AmWINS, a wholesaler): said in red at the top of
// the page's cards from the tab's arrival on any of that carrier's pages, before any fill, while it
// stays there (TNI, 2026-10-26, W44-27: the carrier may decline or route the quote). It is about the
// intake, not the tab's quote, so it needs no evidence the tab holds this client's quote. No stop:
// filling, follow-ups, helpers, Continue and the AI go on as elsewhere, the carrier's own question is
// answered from the intake (the agent's for a policy of no type: TNI, 2026-10-26, R9; Progressive's
// No when that one has expired: T10), and
// Progressive's DeclinationNotice stays its stop page. Not logged: a
// fill run that stopped would count a page nothing stopped. Only for a commercial auto policy, or one
// of no type (util.js quotedCarrierPolicy; TNI, 2026-10-26: answer to PR question 18: not a personal
// auto or GL-only policy). The intake check screen says it too, on this carrier's site only
// (prior.carrier-is-quoted, checkShown).
function showCarrierNote() {
  const box = $('carrier-note');
  const carrier = state.tab?.carrier;
  const p = state.intake?.record?.priorInsurance?.[0];
  const on = !!carrier && quotedCarrierPolicy(p, carrier.id);
  box.hidden = !on;
  if (!on) { box.replaceChildren(); return; }
  const policy = [p.carrier, p.type, p.expiration ? `expires ${p.expiration}` : null].filter(Boolean).join(' · ');
  box.replaceChildren(issueCard({ role: 'alert', title: `The client's current insurance is with ${carrier.name}`,
    text: `${carrier.name} may decline or route this quote. Check with the client before going on.`,
    compare: [['Intake’s current insurance', policy]], notes: ['Filling goes on as usual.'] }));
}

// Review mode (plan.js supportedClass): the intake's business class isn't one this carrier's rules
// were written for, so every standard answer is filled as a check item (Continue waits on every
// page) and the agent is told why, above the page's answers.
function showReviewMode() {
  const box = $('review-note');
  const carrier = state.tab?.carrier;
  const record = state.intake?.record;
  const on = !!carrier && !!record && !supportedClass(record, carrier);
  box.hidden = !on;
  if (!on) { box.replaceChildren(); return; }
  const cls = String(record.operations?.businessClass ?? '').trim();
  box.replaceChildren(issueCard({ tone: 'warn', title: `Review mode: ${cls ? `"${cls}"` : 'no business class'} on the intake`,
    text: `${carrier.name}'s rules cover expediters and general freight. Confirm the marked answers: Continue waits on each page.` }));
}

// A card above the page's answers (or in them): what's wrong or different, in the panel's own
// words, never the page's. `tone`: '' (red: the carrier stopped the quote, a fill failed, the
// quote's state differs), 'warn', 'info' or 'quiet' (a step that is the agent's).
function issueCard({ tone = '', title, text = null, notes = [], compare = [], actions = [], role = 'status' }) {
  return h('div', { class: `issue${tone ? ` ${tone}` : ''}`, role },
    h('div', { class: 'issue-head' }, h('span', { class: 'bang', 'aria-hidden': 'true' }, tone === 'info' ? 'i' : '!'),
      h('div', { class: 'issue-text' }, h('span', { class: 'issue-title' }, title), text ? h('span', {}, text) : null,
        ...notes.map((note) => h('span', { class: 'small-note' }, note)))),
    compare.length ? h('div', { class: 'compare' }, compare.map(([k, v]) => h('span', {}, h('span', { class: 'k' }, `${k}:`), ` ${v}`))) : null,
    actions.filter(Boolean).length ? h('div', { class: 'issue-actions' }, actions.filter(Boolean)) : null);
}

// Pages where the carrier has stopped the quote (Progressive's DeclinationNotice: the client
// already has a commercial auto policy with Progressive). Nothing is filled or clicked there,
// automatically or on request, and Luna isn't asked; the panel says why in red above the page's
// answers (outside the fill report, which Clear marks empties) and the page is the agent's. The
// carrier's reason is said of this client only once the tab is shown to be this intake's quote
// (stopPageIsOurs). Steps of a one-address application that are the agent's (GEICO's Final Quote
// Details, MVR & CLUE, Payment Information: `stopSteps`) are kept the same way, in a quiet card:
// their note is the step's, about no client, so it is said as it is. So are screens that are the
// agent's (`stopButtons`: GEICO's Add USDOT Number), and a screen that is the carrier's stop
// (`stopped`: GEICO's referral, W44-04) is said in red, as a stop page.
function showStopPage() {
  const carrier = state.tab?.carrier;
  const page = pageOf(state.tab?.url);
  const step = tabStep(carrier);
  const note = state.intake ? stopNoteFor(carrier, page, step) : null;
  const box = $('stop-note');
  // A step the fill still answers, with what the carrier says there (GEICO: stop at Quote & Coverages).
  const stepNote = !note && state.intake && step ? carrier?.stepNotes?.[step] ?? null : null;
  box.hidden = !note && !stepNote;
  if (stepNote) { box.replaceChildren(issueCard({ tone: 'info', title: step, text: stepNote })); return; }
  if (!note) { box.replaceChildren(); return; }
  clearTimeout(state.autoTimer);
  state.autoDrawn = null;
  state.autoPending = false;
  state.pagePending = null;
  if (!carrier.stopPages?.[page]) {
    // A stop step's, or a stop screen's (`stopButtons`) on a step that is no stop.
    const screen = step && carrier.stopSteps?.[step] ? null : state.stopScreens?.get(state.tab?.id)?.name;
    // The carrier's own stop on a screen (`stopped`: GEICO's referral, W44-04): in red, as a stop
    // page's. A screen is noted only from this intake's layouts (noteStopScreen), so it is this client's.
    if (carrier.stopButtons?.[screen]?.stopped) {
      box.replaceChildren(issueCard({ role: 'alert', title: `${carrier.name} stopped this quote`, text: note, notes: ['Nothing on this page is filled or clicked.'] }));
      return;
    }
    box.replaceChildren(issueCard({ tone: 'quiet', title: `${screen ?? step}: yours`, text: note,
      notes: [`Nothing on this ${screen ? 'screen' : 'step'} is filled or clicked.`] }));
    return;
  }
  const ours = stopPageIsOurs();
  box.replaceChildren(issueCard({ role: 'alert', title: ours ? `${carrier.name} stopped this quote` : `${carrier.name} stop page`,
    text: ours ? note : 'This tab was on the stop page before this client was loaded; it may be another client\'s quote. Open this client\'s quote.',
    notes: ['Nothing on this page is filled or clicked.'] }));
}

// The tab's quote is for another state than the intake's garaging state (src/quote-state.js): said
// above the page's answers, and filling waits, until the pick matches, the intake does, or the
// agent says the pick is right (for this intake). Also when the pick came before this intake was loaded: the tab's quote
// doesn't change with the intake. A tab that moves to another carrier forgets its pick.
// A tab's quote state: a new pick replaces it (the same pick keeps when it was made and whether the
// agent said it's right); no state forgets it.
function noteQuoteState(tabId, carrier, code) {
  const was = state.quoteStates.get(tabId);
  const same = was && was.carrier === carrier && was.code === code;
  if (code) state.quoteStates.set(tabId, same ? was : { carrier, code, session: usage.currentSession()?.id ?? null, dismissed: null });
  else state.quoteStates.delete(tabId);
  showStateNote();
}

// The quote-state page's pick as it is (a state the page restored or defaulted, or picked before
// the recorder attached): a change would never report it. Read when the recorder announces the
// page, and when the panel finds the tab on it (a recorder already in the page, after the panel
// was closed or reloaded, doesn't announce it again). A pick noted while the page is read (a
// change, a fill) is newer: the read doesn't replace it.
function seedQuoteState(tabId, carrier, page) {
  if (!state.intake || !carrier?.quoteState?.pages.includes(page)) return;
  const known = state.quoteStates.get(tabId);
  readQuoteState(tabId, carrier).then((shown) => { if (shown != null && state.quoteStates.get(tabId) === known) noteQuoteState(tabId, carrier.id, stateCode(shown)); });
}

// The quote-state control's pick on the page's top frame, by its field key: the option's text, ''
// for no state, null when it isn't there (or the page can't be read).
async function readQuoteState(tabId, carrier) {
  const key = carrier?.quoteState?.key;
  if (!inExtension || !key) return null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, args: [key], func: (k) => {
      const el = [...document.querySelectorAll('select')].find((x) => globalThis.__raterFieldKey?.(x) === k);
      const o = el?.selectedOptions?.[0];
      return el ? (o && o.value !== '' ? o.text : '') : null;
    } });
    return res?.result ?? null;
  } catch { return null; }
}

// Progressive opens the quote in a new tab from its home page: that tab's quote is the one picked
// there. Not while no intake is loaded: the tab isn't watched then, so its pick may be stale.
function inheritQuoteState(tab) {
  if (!state.intake) return;
  const pick = state.quoteStates.get(tab?.openerTabId);
  if (pick && Number.isInteger(tab.id) && !state.quoteStates.has(tab.id)) state.quoteStates.set(tab.id, { ...pick });
}

// The tab's quote state against the intake's garaging state (stateIssue): said in red above the
// page's answers, with the pick and the intake's address side by side, "<state> is right" and
// where the address is on the intake. Filling waits meanwhile (dockFor, fillPage, autoFill).
function showStateNote() {
  const box = $('state-note');
  const issue = stateIssue();
  box.hidden = !issue;
  if (!issue) { box.replaceChildren(); return; }
  const { picked, intake, pick } = issue;
  const name = state.tab.carrier.name;
  const before = pick.session !== (usage.currentSession()?.id ?? null);
  const g = state.intake.record.garaging ?? {};
  const address = [g.street, g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const place = sourcePlace('garaging.state', state.intake);
  const pdf = place && pdfAvailable();
  box.replaceChildren(issueCard({ role: 'alert', title: `This ${name} quote is for ${picked}. The intake says ${intake}.`,
    text: `${before ? `Quote started in ${picked} before this intake was loaded. ` : ''}Start the quote in ${intake}, or check the intake.`,
    compare: [['Rater', picked], [`Intake${place ? pdfPageSaid(place.page, ' page ') : ''}`, address || intake]],
    actions: [
      h('button', { type: 'button', class: 'tinted', onclick: dismissState }, `${picked} is right`),
      pdf ? h('button', { type: 'button', class: 'ghost', onclick: () => openPdf({ path: 'garaging.state', label: 'Garaging state', kind: 'check' }) }, `See intake${pdfPageSaid(place.page, ' · p')}`) : null,
    ] }));
}

// The tab's quote is for another state than the intake's garaging state (src/quote-state.js), until
// the pick matches, the intake does, or the agent says the pick is right (for this intake). Also
// when the pick came before this intake was loaded: the tab's quote doesn't change with the
// intake. A tab that moves to another carrier forgets its pick. Returns { picked, intake } (state
// names) with the pick, or null.
function stateIssue() {
  const tabId = state.tab?.id;
  let pick = state.quoteStates.get(tabId);
  if (pick && state.tab?.carrier && pick.carrier !== state.tab.carrier.id) { state.quoteStates.delete(tabId); pick = null; }
  const intakeId = usage.currentSession()?.intakeId ?? null;
  const off = !pick || !state.intake || pick.carrier !== state.tab?.carrier?.id || pick.dismissed === `${intakeId}|${pick.code}`;
  const differs = off ? null : stateMismatch(pick.code, state.intake.record);
  return differs ? { ...differs, pick, intakeId } : null;
}

// "<state> is right" or the dock's Fill anyway: the tab's quote state stands for this intake, and
// filling goes on.
function dismissState() {
  const issue = stateIssue();
  if (!issue) return;
  issue.pick.dismissed = `${issue.intakeId}|${issue.pick.code}`;
  showStateNote();
  renderSteps();
}

// A tab may still show the previous client's quote after an intake is loaded (or the panel
// started): the same evidence as for layouts (a new page since, or a fill with this intake).
function stopPageIsOurs() {
  return !state.layoutHold || state.layoutReadyTabs.has(state.tab?.id);
}

export { announce, cancelLayouts, dismissState, dropReports, fillContext, fillOptions, fillProblem, holdLayouts, inheritQuoteState, intakeEdited, issueCard, logFill, logFillError, noteChangedAfterDone, notePageMoved, noteQuoteDone, noteQuoteState, noteStaleFill, onQuotePage, pageMoved, putReport, recordLayout, recount, rememberFill, renderDock, renderSite, renderSteps, resetViews, runPendingPage, scheduleAutoFill, scheduleLayout, scrollBehavior, seedQuoteState, showFinish, showPast, showStateNote, showStopPage, stateIssue, stopFill, stopPageIsOurs, tabMaps, unlockAudio, viewOf, watchFill };
