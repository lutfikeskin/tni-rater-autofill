// The side panel: filling and capturing.
// One part of the panel; sidepanel.js wires the parts together.
import { sourcePlace } from '../../src/intake-source.js';
import { fieldInfo } from '../../src/schema.js';
import { buildPlan, redactionTerms } from '../../src/plan.js';
import { unitListSpecs, unitToAdd, unitMissing, unitMissingItem } from '../../src/units.js';
import { get } from '../../src/util.js';
import { fieldChangeEvent, checkDismissedEvent, redactor, knownStep } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { isStandard } from '../../src/resolution.js';
import { inExtension, popped } from './env.js';
import { $, aiSnapshotFieldMatches, h, keepReport, memory, persistAgentKeys, persistAiPending, persistDoneActions, persistGuardedEdits, retireAiOrigins, state } from './core.js';
import { save } from './intake.js';
import { renderPickers, showScreen } from './record.js';
import { ensureRecorder, pageOf, tellRecorder } from './usage.js';
import { announce, dropReports, fillContext, fillOptions, fillProblem, issueCard, logFill, logFillError, noteChangedAfterDone, notePageMoved, noteStaleFill, onQuotePage, pageMoved, putReport, recordLayout, recount, rememberFill, renderDock, renderSite, renderSteps, runPendingPage, scheduleAutoFill, scheduleLayout, scrollBehavior, showFinish, showStateNote, showStopPage, stateIssue, tabMaps, viewOf, watchFill } from './coordinator.js';
import { aiDecisionEvent, remarkAi, runAssist, syncAiBanner } from './assistant.js';
import { openPdf, pdfAvailable, pdfPageSaid } from './pdf-view.js';
import { editScope, fillSkip, fillSkipBy, formScoped, stepScope, tabStep } from './scope.js';
import { fillCurrent, fillErrorMessage, staleFill } from './fill-checks.js';
import { liveOf } from './live.js';
import { agentPickable, answerSources, choiceSaid, choicesOf, currentReportKey, finishLeftOk, groupRows, itemsLeft, looseText, reportKey, stopNoteFor } from './report-model.js';
import { answerRecord, needId, needRecord, reopenRow, setHead, settleRow, showLive } from './report-rows.js';
import { mountRows } from './report-view.jsx';
import { flushSync } from 'react-dom';
/** @import { CarrierConfig, FillReport } from '../../types.js' */

// ---------------------------------------------------------------------------------------------
// Filling and capturing

// Carriers whose widgets live in the page's own JavaScript (ExtJS) need the MAIN world.
/** @param {CarrierConfig | null} carrier @returns {'MAIN' | 'ISOLATED'} */
const worldFor = (carrier) => (carrier?.world === 'MAIN' ? 'MAIN' : 'ISOLATED');

/** @param {number} tabId @param {CarrierConfig} carrier */
async function injectKit(tabId, carrier) {
  // The buttons the kit presses, clicked from the page's own world (`pressInPage`: GEICO, W43-44).
  if (carrier?.pressInPage) await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', files: ['src/content/page-press.js'] });
  // The carrier's page adapter (its own widgets: src/content/carriers/) goes in before the engine.
  const adapter = carrier?.pageAdapter ? [carrier.pageAdapter] : [];
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: worldFor(carrier), files: ['src/content/field-key.js', ...adapter, 'src/content/pagekit.js'] });
}

/**
 * @param {number} tabId
 * @param {CarrierConfig} carrier
 * @param {Function} func  run in each frame, after the kit is injected
 * @param {any[]} [args]
 * @param {number[]} [frameIds]
 */
async function runKit(tabId, carrier, func, args = [], frameIds) {
  await injectKit(tabId, carrier);
  return chrome.scripting.executeScript({ target: { tabId, ...(frameIds ? { frameIds } : { allFrames: true }) }, world: worldFor(carrier), func, args });
}

// `auto`: 'page' when started because a new page opened (setting "Fill each new page").
// `confirmed`: the page's receipt the agent approved with Looks right (lookRight).
async function fillPage({ auto = false, confirmed = null, continuing = false } = {}) {
  // The carrier stopped the quote on this page: nothing is filled or clicked, even on request.
  if (state.intake && stopNoteFor(state.tab?.carrier, pageOf(state.tab.url))) { showStopPage(); return; }
  // The tab's quote is for another state than the intake's: nothing is filled until the agent says
  // the state is right (or Fill anyway), on request or automatically (stateIssue).
  if (state.intake && stateIssue()) { showStateNote(); renderSteps(); return; }
  // A new page that opens while the previous one is still finishing its fill is filled right
  // after it (it used to be skipped: "it stopped here").
  if (state.filling && auto === 'page') { state.pagePending = pageOf(state.tab?.url); return; }
  if (state.filling || state.closing || state.resetting || !state.intake || !state.tab?.carrier || (auto && state.autoPaused)) return;
  // Back on a step that takes follow-ups only for new questions (newQuestionsOnlySteps) after its
  // fill: only the agent, or new questions, fill it again.
  if (auto && state.tab.carrier.newQuestionsOnlySteps?.includes(tabStep(state.tab.carrier)) && state.reports.get(currentReportKey())?.fields) return;
  // The carrier's portal pages outside a quote (Progressive's home / quote search) are never
  // filled, and the AI isn't asked about them.
  if (!onQuotePage()) {
    if (!auto) fillProblem({ tabId: state.tab.id, page: pageOf(state.tab.url), carrier: state.tab.carrier }, 'This is the portal. Open a quote, then fill.', 'notice');
    return;
  }
  if (!auto) state.autoPaused = false;
  state.filling = true;
  clearTimeout(state.autoTimer);
  state.autoDrawn = null;
  const { id: tabId, carrier } = state.tab;
  const page = pageOf(state.tab.url);
  // Looks right never replaces anything: the page is continued as the agent approved it. Nor does
  // the dock's Continue (W43-40).
  const overwrite = auto || confirmed || continuing ? false : $('overwrite').checked;
  // Before any waiting: the agent may pick another vehicle or tab, or load another intake, while
  // the carrier works (fillContext; the view is taken there).
  const ctx = fillContext({ tabId, carrier, page, tabUrl: state.tab.url, auto, overwrite, asked: !auto && !confirmed });
  await pickListItem(carrier, page, ctx);
  if (staleFill(ctx) || state.tab?.id !== tabId) { state.filling = false; renderSite(); return; }
  // The list page may have picked the next vehicle or driver: the plan is for that one.
  ctx.active = { ...state.active };
  // And the unit it adds, if any (pickUnitToAdd): the chooser's answer and the add helpers.
  let plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
  // The page view lists the answers as they go in and the dock has Stop; the new report replaces
  // the last one when it comes (kept until then, in case this fill stops before it gets anywhere).
  state.fillingFor = { run: ctx.run, tabId, carrier, key: reportKey(tabId, page, carrier, ctx.active), filled: 0, rows: [], stopping: false };
  const unwatch = watchFill(ctx);
  renderSteps();
  const started = Date.now();
  let assistFrames = null;
  let followUp = false;
  // The page moved on before the fill began (pageMoved): the page in front gets its fill after this.
  let moved = false;
  // Our own fills aren't the agent's changes: pause the recorder while filling.
  try {
    await ensureRecorder();
    await tellRecorder('pause', tabId);
    await retireAiOrigins({ tabId, tabUrl: ctx.tabUrl, intake: ctx.intake, carrier });
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (!fillCurrent(ctx)) return;
    // The agent's edits on this page as the fill's tab holds them (retiring AI picks may just
    // have released some), never the tab in front.
    // Honor the latest switch after preparation, and log the same value used by the kit.
    ctx.settings.autoAdvance = !!$('auto-advance').checked;
    // The add helpers are clicked only with the switch on now.
    if (ctx.adding) plan = buildPlan(ctx.intake.record, carrier, ctx.adding ? { ...ctx.active, adding: ctx.adding } : ctx.active);
    // Stopped while the panel prepared: the kit isn't asked to fill at all.
    if (state.fillingFor?.run === ctx.run && state.fillingFor.stopping) {
      tabMaps(tabId).autoPaused = true;
      fillProblem(ctx, 'You stopped the fill. Nothing was filled or clicked.', 'notice');
      return;
    }
    // The tab moved on to another page while the panel prepared: that one isn't filled with this
    // page's plan (the kit checks again as it starts: `expectPage`).
    if (await pageMoved(ctx)) { moved = true; notePageMoved(ctx); return; }
    const skipBy = fillSkipBy(tabMaps(tabId).agentKeys, ctx.page, carrier, ctx.active);
    // The agent's Fill this page gives back an answer the page took back (keepTakenBack): GEICO's
    // own coverage choice put back over the fill's, on a question the agent didn't answer
    // themselves (their answers are in `skip`). An automatic fill keeps and flags it.
    const options = fillOptions(carrier, { overwrite, skip: fillSkip(tabMaps(tabId).agentKeys, ctx.scope, ctx.page, carrier), ...(skipBy ? { skipBy } : {}), ...(confirmed ? { confirmed } : {}), ...(ctx.asked ? { takenBack: null } : {}), run: ctx.run, expectPage: ctx.page }, ctx.settings.autoAdvance, ctx.active, ctx.unitsListed);
    const results = await runKit(tabId, carrier, (p, o) => globalThis.__raterKit.fill(p, o), [plan, options]);
    // The intake changed meanwhile: the page holds the earlier one's answers (fillContext).
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    if (results.some((r) => r.result?.pageMoved)) { moved = true; notePageMoved(ctx); return; }
    // Filled with this intake (and the fill went through): this tab's layouts may be taken.
    state.layoutReadyTabs.add(tabId);
    noteMissingUnit(results, ctx);
    const frames = results.map((r) => r.result).filter(Boolean);
    const retrying = rememberFill(frames, ctx);
    tabMaps(tabId).autoPages.add(page);
    followUp = afterFill(frames, ctx);
    logFill(ctx, frames, results, started);
    // The report is its own tab's: kept for it when the agent has moved to another tab meanwhile.
    // Stopped by the agent before the kit was done (a frame halted): said so, and the dock offers to
    // fill the rest.
    renderReport(frames, { ...ctx, plan, retrying, stopped: state.fillingFor?.run === ctx.run && !!state.fillingFor.stopping && frames.some((f) => f.halted) });
    if (!fillCurrent(ctx)) return;
    recordLayout(page);
    assistFrames = frames;
  } catch (e) {
    if (staleFill(ctx)) { noteStaleFill(ctx); return; }
    tabMaps(tabId).autoPaused = true;
    // The message may quote the page, so it's redacted with the origin intake.
    logFillError(ctx, e);
    fillProblem(ctx, fillErrorMessage(ctx, e));
  } finally {
    unwatch();
    await tellRecorder('resume', tabId);
    state.filling = false;
    if (state.fillingFor?.run === ctx.run) state.fillingFor = null;
    renderSite();
    // The page in front, which this fill wasn't for, gets its own fill.
    if (moved && fillCurrent(ctx)) runPendingPage(ctx);
  }
  if (!fillCurrent(ctx)) return;
  // The agent's next step is the page's answers: in view (showFinish).
  // An automatic fill too: the agent sees what it filled and what's left, as after their own.
  showFinish({ auto: !!auto });
  runPendingPage(ctx);
  await remarkAi({ tabId, page, carrier });
  if (!fillCurrent(ctx)) return;
  if (assistFrames && !assistFrames.some((f) => f.halted)) assistAfterFill(assistFrames, { tabId, page, carrier }, followUp);
}

// On the carrier's vehicle list page, work on the first intake vehicle not added yet (its Add
// Vehicle or VIN lookup not done in this quote). When every vehicle is in, the active one stays
// and nothing is left to add, so the page's Continue is clicked. Trailers (added from the same
// list) and the driver list work the same way (a driver or trailer counts as entered once its
// page was filled).
async function pickListItem(carrier, page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  await pickUnitForm(carrier, ctx);
  if (!fillCurrent(ctx)) return;
  await pickUnitToAdd(carrier, ctx);
  if (!fillCurrent(ctx)) return;
  await verifyListed(carrier, page, ctx);
  // Another tab came to the front while the list was read: its own fill picks for it.
  if (!fillCurrent(ctx)) return;
  const lists = [
    [carrier?.vehicleList, 'vehicles', (i) => ['lookupVin', 'addVehicle'].some((a) => state.doneActions.has(`${a}:${i}`))],
    // A trailer only once its page was filled: Add Trailer opened and left (an unsupported tile)
    // doesn't count, and Vehicle Summary holds Continue for it (the action's `unfinished` note).
    [carrier?.trailerList, 'trailers', (i) => state.doneActions.has(`trailerEntered:${i}`)],
    [carrier?.driverList, 'drivers', (i) => state.doneActions.has(`driverEntered:${i}`)],
  ];
  for (const [listPage, list, done] of lists) {
    if (!listPage || page !== listPage) continue;
    const next = (state.intake?.record[list] ?? []).findIndex((_, i) => !done(i));
    if (next < 0 || next === state.active[list]) continue;
    state.active[list] = next;
    await save();
    if (!fillCurrent(ctx)) return;
    renderPickers();
  }
}

// Where one address draws each unit's form (formScoped: GEICO's Add Vehicle or Trailer, Add
// Driver), a new, blank form while the panel's unit was already filled on another one is the next
// intake unit no form was filled for (FL live run, 2026-10-21: the second vehicle's and the second
// driver's forms waited for a pick). The driver the carrier lists itself (`listedDriver`: GEICO's
// owner who drives) is never the one an Add Driver form is for, nor the one its quote leaves out
// (`omittedDriver`: GEICO's owner who doesn't drive, TNI 2026-10-26 and 2026-10-27, T1, V3). A form with answers (a
// saved unit opened again) or with no unit left keeps the pagekit hold.
async function pickUnitForm(carrier, ctx) {
  if (!formScoped(carrier) || !Number.isInteger(ctx.tabId) || !ctx.intake) return;
  let forms = null;
  try {
    const frames = await runKit(ctx.tabId, carrier, () => globalThis.__raterKit?.unitFormsNow?.() ?? null);
    forms = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  if (!fillCurrent(ctx)) return;
  const record = ctx.intake.record ?? {};
  let picked = false;
  for (const { list, id, blank } of forms ?? []) {
    const bound = state.unitForms?.[list] ?? {};
    if (!blank || Object.hasOwn(bound, id)) continue;
    const listed = list === 'drivers' ? carrier.listedDriver?.(record) ?? -1 : -1;
    const omitted = list === 'drivers' ? carrier.omittedDriver?.(record) ?? -1 : -1;
    const taken = new Set(Object.values(bound));
    const free = (i) => !taken.has(i) && i !== listed && i !== omitted;
    const active = state.active[list] ?? 0;
    if (free(active)) continue;
    const next = (record[list] ?? []).findIndex((_, i) => free(i));
    if (next < 0) continue;
    state.active[list] = next;
    picked = true;
  }
  if (!picked) return;
  await save();
  if (fillCurrent(ctx)) renderPickers();
}

// Where one address shows the quote's unit lists on a step (carrier.unitLists: GEICO's Vehicles and
// Trailers, Drivers), the unit the fill adds next (`ctx.adding`: { list, index }, for the plan: the
// chooser's answer and the add helpers), read from the lists and chosen by src/units.js unitToAdd:
// the intake's next unit no fill answered a form for and the list doesn't show (marked
// `<unit>Entered:<i>` while the list is on screen), never the driver GEICO lists itself, none while
// the list holds as many units as the intake, and none the list can't be read for while it has a
// row no intake unit is known to be on (it may be that one, added by hand). With no unit form on
// screen (the list, the chooser, the owner's own forms) the picker moves to that unit, so the plan
// is for it. The plan clicks the list's "+" and the chooser's Next for it (`click`) with "Fill the
// pages" or "Click Continue when the page is done" on (TNI, FL live run 5, 2026-10-21, W43-20), and
// on the agent's own Fill this page with both off (FL live run 6, 2026-10-21: Fill this page on the
// vehicle list did nothing, and the agent clicked "+"); an automatic fill with both off only answers
// the chooser.
async function pickUnitToAdd(carrier, ctx) {
  ctx.adding = null;
  ctx.unitsListed = false;
  ctx.unitMissing = null;
  if (!carrier?.unitLists?.length || !Number.isInteger(ctx.tabId) || !ctx.intake) return;
  const record = ctx.intake.record ?? {};
  const specs = unitListSpecs(carrier, record);
  let seen = null;
  try {
    const frames = await runKit(ctx.tabId, carrier, (specs) => {
      const kit = globalThis.__raterKit;
      if (!kit?.unitList) return null;
      return { step: kit.step?.() ?? '', forms: kit.unitFormsNow?.() ?? null, lists: specs.map((s) => kit.unitList(s.selector, s.items)) };
    }, [specs.map(({ selector, items }) => ({ selector, items }))]);
    seen = frames.map((f) => f?.result).find((x) => x && Array.isArray(x.lists)) ?? null;
  } catch { return; }
  if (!seen || !fillCurrent(ctx)) return;
  const next = unitToAdd(carrier, record, knownStep(carrier, seen.step), seen, { unitForms: state.unitForms, done: state.doneActions });
  if (!next) return;
  // Every intake unit on the list on screen: its Looks Good may be clicked (advanceFor). A list
  // holding as many rows as the intake that isn't read as complete is said in the usage log, in
  // counts only (W43-40: GEICO's Looks Good never clicked on a list that needed a VIN or name read).
  ctx.unitsListed = !!next.complete;
  const read = next.read;
  ctx.listNote = !next.complete && read && read.rows >= read.units ? `list: ${read.rows} rows for ${read.units} units, ${read.shown} shown, ${read.saved} saved by a fill` : null;
  if (next.marks.some((id) => !state.doneActions.has(id))) {
    next.marks.forEach((id) => state.doneActions.add(id));
    persistDoneActions(ctx.tabId, state.doneActions);
  }
  if (!next.adding) return;
  ctx.adding = { ...next.adding, click: !!(ctx.settings?.autoPages || ctx.settings?.autoAdvance || ctx.asked) };
  const { list, index } = next.adding;
  if (next.move && state.active[list] !== index) {
    state.active[list] = index;
    await save();
    if (fillCurrent(ctx)) renderPickers();
  }
  // The list on screen without this unit, and no helper that would add it even with its clicks
  // allowed (GEICO's Add Driver while the panel's driver is another one): named after the fill,
  // left for the agent (noteMissingUnit; W44-01, OH 2026-10-26: the quote printed with one of two
  // drivers, the panel silent).
  try { ctx.unitMissing = unitMissing(next, buildPlan(record, carrier, { ...state.active, adding: { ...next.adding, click: true } })); } catch { /* no plan, nothing said */ }
}

// The unit pickUnitToAdd found missing from the list on screen with nothing to add it (ctx.unitMissing),
// as an item the top frame's report leaves for the agent, which holds its Continue: the list's Looks
// Good is the agent's (W44-01).
function noteMissingUnit(results, ctx) {
  if (!ctx.unitMissing) return;
  const top = results.find((r) => r.frameId === 0)?.result;
  if (!top || top.halted) return;
  const item = unitMissingItem(ctx.carrier, ctx.intake?.record ?? {}, ctx.unitMissing);
  top.noData = [...(top.noData ?? []), item];
  top.blockers = [...(top.blockers ?? []), `needs you: ${item.label}`];
}

// On the vehicle list, a trailer is on the quote when the list shows its VIN (Progressive lists each
// unit with its VIN), and not when the list shows the quote's vehicles by VIN but not this one
// (Add Trailer left by Back or the top menu, Codex on PR #43). Without VINs to compare, the return
// from its page decides (unitArrival).
async function verifyListed(carrier, page, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  if (carrier?.driverList && page === carrier.driverList) return verifyDrivers(carrier, ctx);
  const onList = (carrier?.trailerList && page === carrier.trailerList) || (carrier?.vehicleList && page === carrier.vehicleList);
  if (!onList || !Number.isInteger(ctx.tabId)) return;
  const record = ctx.intake?.record ?? {};
  const vin = (u) => String(u?.vin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const trailers = (record.trailers ?? []).map(vin);
  const vehicles = (record.vehicles ?? []).map(vin);
  if (![...vehicles, ...trailers].some((v) => v.length >= 11)) return;
  let shown = null;
  const tabId = ctx.tabId;
  try {
    const frames = await runKit(tabId, carrier, (vins) => globalThis.__raterKit?.listed?.(vins) ?? null, [[...vehicles, ...trailers]]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  if (!shown || !fillCurrent(ctx)) return;
  const showsVins = shown.slice(0, vehicles.length).some(Boolean);
  // A vehicle back from its own pages (vehicleReturned, unitArrival) that the list now shows by
  // its VIN is on the quote, however it got there (the agent's own VIN lookup included): Add
  // Vehicle is never clicked for it again (live run 2026-10-10: the automatic fill added the same
  // vehicle a second time). The VIN alone isn't enough: the list also shows the vehicles the USDOT
  // lookup found, which aren't on the quote until added (audit 2026-10-10). A VIN not shown
  // proves nothing.
  if (carrier.vehicleList === page) {
    vehicles.forEach((v, i) => {
      if (v.length >= 11 && shown[i] && state.doneActions.has(`vehicleReturned:${i}`)) for (const id of [`lookupVin:${i}`, `addVehicle:${i}`]) state.doneActions.add(id);
    });
  }
  trailers.forEach((v, i) => {
    if (v.length < 11) return;
    if (shown[vehicles.length + i]) state.doneActions.add(`trailerEntered:${i}`);
    else if (showsVins) state.doneActions.delete(`trailerEntered:${i}`);
  });
  persistDoneActions(tabId, state.doneActions);
}

// On the driver list, a driver it shows by name (first and last) is entered, also when the panel
// was closed while the agent finished the driver's page (Codex on PR #43). A name not shown proves
// nothing (the list may write it another way): the return from the driver page decides. Nor does
// a name another intake driver's name holds (two John Smiths, Ann Lee and Mary Ann Lee): one row
// would count for both, and the other driver would never be added (Codex on PR #43).
async function verifyDrivers(carrier, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  if (!Number.isInteger(ctx.tabId)) return;
  const words = (d) => [d.first, d.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
  const drivers = (ctx.intake?.record?.drivers ?? []).map(words);
  const names = (ctx.intake?.record?.drivers ?? []).map((d, i) => drivers.some((other, j) => j !== i && drivers[i].every((w) => other.includes(w)))
    ? [] : [d.first, d.last].filter(Boolean));
  if (!names.some((n) => n.length >= 2)) return;
  let shown = null;
  const tabId = ctx.tabId;
  try {
    const frames = await runKit(tabId, carrier, (items) => globalThis.__raterKit?.listed?.(items) ?? null, [names]);
    shown = frames.map((f) => f?.result).find(Array.isArray) ?? null;
  } catch { return; }
  // The agent switched tabs meanwhile: the answer is about the other tab's quote (Codex on PR #43).
  if (!shown || !fillCurrent(ctx)) return;
  shown.forEach((on, i) => { if (on) state.doneActions.add(`driverEntered:${i}`); });
  persistDoneActions(tabId, state.doneActions);
}

// A driver or trailer is entered once the carrier took its page: its list comes back from it (its
// Continue went through). Answers filled there alone don't count: the page may still have failed
// or been left (Codex on PR #43). A driver page Progressive filled itself from Business Owner Info
// counts the same way once continued (OK 2026-10-07: the list added that driver again).
function unitArrival(carrier, from, page) {
  for (const [unitPage, listPage, list, marker] of [[carrier?.driverPage, carrier?.driverList, 'drivers', 'driverEntered'], [carrier?.trailerPage, carrier?.trailerList, 'trailers', 'trailerEntered']]) {
    if (!unitPage || from !== unitPage || page !== listPage) continue;
    // The unit the form named, when it named one (W43-37): a form for no intake driver marks none.
    const named = state.unitNamed?.list === list && state.unitNamed.page === unitPage ? state.unitNamed : null;
    const index = named ? named.index : state.active[list] ?? 0;
    if (index != null) state.doneActions.add(`${marker}:${index}`);
    if (named) state.unitNamed = null;
    persistDoneActions();
  }
  // Back on the vehicle list from the active vehicle's pages: only a mark that it may be on the
  // quote; the list showing its VIN decides (verifyListed).
  if (carrier?.vehicleList && page === carrier.vehicleList && carrier.vehiclePages?.includes(from)) {
    state.doneActions.add(`vehicleReturned:${state.active.vehicles ?? 0}`);
    persistDoneActions();
  }
}

// Bookkeeping after a fill: a click that opens more
// questions (cargo "+", Add a commodity) gets a follow-up fill once the page has drawn them.
// Returns whether that follow-up fill is coming.
/** @param {FillReport[]} frames */
function afterFill(frames, { tabId = state.tab?.id, carrier, page, run = null, intake = state.intake, revision = state.intakeRevision, active = state.active }) {
  const ctx = { tabId, carrier, page, run, intake, revision };
  const maps = tabMaps(tabId);
  // A helper found already done on the page (alreadyShown) clicked nothing: no follow-up for it.
  const clicked = frames.some((f) => (f.actions ?? []).some((a) => !a.alreadyShown));
  const moved = frames.some((f) => f.navigatedTo || f.advanced || f.halted);
  const advanced = frames.find((f) => f.advanced && f.signatureBefore != null);
  // Scoped by the step the fill continued from, as the kit read it (the tab's step is noted later);
  // per form and button where the carrier continues a step so (advance `byForm`: advanceKey).
  const doneKey = advanced?.stepKey ? stepScope(page, carrier, active, carrier?.layoutSteps ? knownStep(carrier, advanced.stepKey) : undefined) + (advanced.advanceKey ?? advanced.stepKey) : null;
  if (doneKey) maps.doneSteps.add(doneKey);
  // Keep the origin's bookkeeping, but never start helpers or Continue work in another tab.
  if (!fillCurrent(ctx)) return false;
  if (clicked && !moved) setTimeout(() => {
    if (fillCurrent(ctx) && pageOf(state.tab?.url) === page) scheduleAutoFill(page);
  }, 900);
  if (advanced) watchNextStep(carrier, page, advanced.signatureBefore, doneKey, run, ctx);
  return clicked && !moved && !state.autoPaused && $('auto-followups').checked;
}

// Luna is asked once the page has stopped changing: after the last follow-up fill of a helper
// chain (cargo "+", Add a commodity), and never about a page the fill has just left
// (2026-10-05: asked while the cargo follow-up still ran, its answer came back stale).
function assistAfterFill(frames, ctx, followUp) {
  const moved = frames.some((f) => f.navigatedTo || f.advanced);
  const wait = followUp && !moved ? ctx.page : null;
  // The agent switched rater tabs while this fill ran: its marker goes to its own tab's session.
  if (state.tab?.id !== ctx.tabId) {
    const saved = state.tabSessions.get(ctx.tabId);
    if (saved) saved.assistPage = wait;
    return;
  }
  state.assistPage = wait;
  if (!followUp && !moved) runAssist(frames, ctx);
}

// After Continue on an application that keeps one address for every step (AmWINS' Save &
// Continue), no page_view comes: wait until the questions on screen have changed (and stopped
// changing), then fill the new step. If the address changes instead, page_view handles it. Never
// fills the old step again, so Continue can't be clicked twice.
// A Continue that didn't take (the page neither moved nor changed for about 6 s, and isn't
// loading) is tried once more: Progressive's Change Payment Plan lost one while it redrew.
// When the second click doesn't take either, automatic filling pauses and the agent is told
// (audit 2026-10-08, finding 6): until then the lost Continue went unreported.
// A carrier without the retry (`continueRetry: false`: GEICO, FL live run 4, 2026-10-21, where the
// retry sent Next again while GEICO still worked on the first) is never clicked again: its page
// may load for up to a minute, and a quiet page that hasn't moved for about 18 s is the agent's.
// `doneKey`: the continued step's entry in state.doneSteps (see stepScope); `run`: the fill's.
// The page is read every 150 ms, and the new step is filled once three reads in a row (300 ms) show
// the same questions: the same 300 ms as when it was read every 300 ms and two reads had to agree,
// which made the new step wait 0.6 s at least (0.63 s on GEICO's 114 fills after a Continue since
// 2026-10-15). The patience is counted in reads as before: about 6 s (18 s without the retry) of a
// page unchanged since the Continue, 30 s (60 s) in all.
async function watchNextStep(carrier, page, before, doneKey = null, run = null, ctx = { tabId: state.tab?.id, intake: state.intake, revision: state.intakeRevision }) {
  const tabId = ctx.tabId;
  if (!$('auto-followups').checked && !$('auto-pages').checked) return;
  let last = null;
  let same = 0;
  let unchanged = 0;
  const retries = carrier.continueRetry !== false;
  const patience = retries ? 40 : 120;
  for (let i = 0; i < (retries ? 200 : 400); i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!fillCurrent(ctx) || pageOf(state.tab?.url) !== page || !state.intake) return;
    let now = null;
    try {
      // While the page saves / reloads (its loading overlay) the step isn't ready yet. A frame without
      // the kit (its document replaced after the kit went in) reads as nothing, as the snapshot reads do.
      const results = await runKit(tabId, carrier, () => (!globalThis.__raterKit || globalThis.__raterKit.busy() ? null : globalThis.__raterKit.signature()));
      now = results.find((r) => r.frameId === 0)?.result ?? null;
    } catch { return; }
    if (!fillCurrent(ctx) || pageOf(state.tab?.url) !== page) return;
    same = now === last ? same + 1 : 0;
    last = now;
    if (now != null && now !== before && same >= 2) {
      if (state.filling) state.pagePending = page;
      else fillPage({ auto: 'page' });
      return;
    }
    unchanged = now != null && now === before ? unchanged + 1 : 0;
    if (retries && unchanged >= patience && doneKey && !state.filling && !state.advanceRetried.has(doneKey)) {
      state.advanceRetried.add(doneKey);
      state.doneSteps.delete(doneKey);
      fillPage({ auto: 'page' });
      return;
    }
    if (unchanged >= patience && doneKey && !state.filling && (!retries || state.advanceRetried.has(doneKey))) {
      state.autoPaused = true;
      fillProblem({ tabId, page, carrier }, 'Continue didn\'t take: click it yourself.');
      if (!carrier.practice) usage.log({ type: 'fill_error', carrier: carrier.id, page, ...(run ? { run } : {}), auto: 'page', error: 'continue did not take' });
      return;
    }
  }
}

// "Mark done" on an item left for the agent: they answered it, or it stays as the page has it.
// Its field then joins the agent's on this page, as an edit there does: no fill changes it and
// Continue no longer waits on it. Nothing is filled or clicked now (Continue stays its own click),
// and it can be undone until the agent edits the field. `rec`: its row (needRecord).
async function markDone(rec, key, tabId, page, x = null) {
  if (!key || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  // Which question the agent marked done, and why it needed them: the review sees what was
  // waved through, not only what was filled.
  if (x && state.intake && !state.tab?.carrier?.practice) {
    usage.log({ ...checkDismissedEvent(x, { redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt }),
      carrier: state.tab.carrier?.id ?? null, page, view: viewOf(tabId, page, state.tab.carrier) });
  }
  const scope = editScope(page);
  const keys = state.agentKeys.get(scope) ?? new Set();
  const had = keys.has(key);
  keys.add(key);
  state.agentKeys.set(scope, keys);
  await persistAgentKeys();
  // Already the agent's (an edit on the page): nothing to undo. The undo takes it back from where
  // it was marked: the step, unit or form may be another by then (Next, a pick, a fill).
  settleNeed(rec, 'marked', had ? null : () => undoMarkDone(rec, key, tabId, page, scope));
}

// "Mark done" on a helper's reminder (no field: Progressive's Rates on an NTL quote with cargo, after
// NTL): the helper joins the tab's done actions, as one the fill clicked, so no fill reports it again
// and what waits on it goes on. Logged as a Mark done is. It can be undone, as Mark done can.
async function markActionDone(rec, id, tabId, page, x = null) {
  if (!id || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  if (x && state.intake && !state.tab?.carrier?.practice) {
    usage.log({ ...checkDismissedEvent(x, { redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt }),
      carrier: state.tab.carrier?.id ?? null, page, view: viewOf(tabId, page, state.tab.carrier) });
  }
  const had = state.doneActions.has(id);
  state.doneActions.add(id);
  await persistDoneActions(tabId);
  settleNeed(rec, 'marked', had ? null : async () => {
    if (state.filling || state.tab?.id !== tabId || rec.settled !== 'marked') return;
    state.doneActions.delete(id);
    await persistDoneActions(tabId);
    reopenRow(rec);
    drawRow(rec);
    recount();
  });
}

async function undoMarkDone(rec, key, tabId, page, scope = editScope(page)) {
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page || rec.settled !== 'marked') return;
  state.agentKeys.get(scope)?.delete(key);
  await persistAgentKeys();
  // Open again: its row says what it waits on, and the note is empty.
  reopenRow(rec);
  drawRowNow(rec);
  rowNodes.get(rec)?.querySelector('.mark-done')?.focus();
  recount();
}

// "Show on page" on an item left for the agent: the carrier page scrolls to its field and the
// field's mark flashes (pagekit reveal), in whichever frame has it. Nothing is filled, clicked or
// focused there. Only on the item's own tab and page, as for Mark done. A field the page doesn't
// show now (in a closed section, or gone) is said on the item for a few seconds.
async function showOnPage(rec, x, tabId, page, carrier) {
  if (!x.key || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  let found = false;
  try {
    const frames = await runKit(tabId, carrier, (key, label) => globalThis.__raterKit?.reveal?.(key, label) === true, [x.key, x.label ?? null]);
    found = frames.some((f) => f.result === true);
  } catch { /* the page is navigating */ }
  clearTimeout(whereTimers.get(rec));
  rec.where = found ? null : 'Not on the page now (it may be in a closed section).';
  drawRow(rec);
  if (found) return;
  announce(rec.where);
  whereTimers.set(rec, setTimeout(() => { rec.where = null; drawRow(rec); }, 6000));
  // Gone from the page, not in a closed section the fill knew of: it leaves the list (checkItems).
  checkItems();
}
// The timer that clears what Show on page said of a row.
const whereTimers = new WeakMap();

// The invariant of the review list (docs/browser-filling.md, "Only what is on the page"): it lists
// only questions the rater page has, and says what they show from the page itself. The fill's report
// is made so as the fill ends (pagekit reconcile); the page may change after it (GEICO draws a CSL
// liability limit's redraw a moment later), and a kept report is of the page as it was.

// What the page shows now for `items` ([{ key, label, stepId }]), from all of the tab's frames in one
// message (pagekit present: one read of each frame): [{ key, label, controlKind, options, current,
// shown, agrees, shared }] for those it has. Null when the page couldn't be read (navigating, no
// kit): nothing is judged then.
async function liveItems(tabId, carrier, items, plan = []) {
  if (!items.length) return [];
  // Fields the plan fills while they are hidden (a fill's hiddenOk: AmWINS' earlier steps), and the
  // rules that answered the answers asked about, so the kit judges each as fill does.
  const hidden = (plan ?? []).filter((s) => s.hidden && s.selector).map((s) => s.selector);
  const ids = new Set(items.map((x) => x.stepId).filter((id) => id != null).map(String));
  const steps = (plan ?? []).filter((s) => ids.has(String(s.id)));
  let frames;
  try {
    frames = await runKit(tabId, carrier, (asked, hiddenOk, rules) => globalThis.__raterKit?.present?.(asked, hiddenOk, rules) ?? null, [items, hidden, steps]);
  } catch { return null; /* the page is navigating */ }
  const read = (frames ?? []).filter((f) => Array.isArray(f.result));
  return read.length ? read.flatMap((f) => f.result) : null;
}
// A kept report's frames as the page is now (restoreReports): an item with a field stays only where
// the page has it (`live`, liveItems) or the fill knew it off screen (`offPage`), saying what the page
// shows and offers now. Unread (`live` null: another page is in front, or the page couldn't be read),
// none is dropped and none says what the page shows: checkItems reads it once its page is in front.
// An answer (filled, or kept as the page had it) whose field is gone is `gone` (no row); the others
// show what the page shows (`now`), `changed` where that is no longer the fill's answer.
function liveFrames(frames, live) {
  const answer = (x, filled) => {
    if (!x.key || String(x.key).startsWith('extra-row:')) return x;
    const now = live ? liveOf(live, x.key, x.label) : null;
    const out = { ...x };
    delete out.now;
    if (!now) {
      if (live && !x.offPage) out.gone = true;
      return out;
    }
    delete out.gone;
    if (now.shared || now.shown == null) return out;
    out.now = now.shown;
    delete out.changed;
    if (filled && now.agrees !== true && looseText(now.shown) !== looseText(x.shown)) out.changed = x.changed ?? 'page';
    return out;
  };
  const fresh = (x) => {
    if (!x.key || String(x.key).startsWith('extra-row:')) return x;
    const now = live ? liveOf(live, x.key, x.label) : null;
    // In the page but not shown (`hidden`: a collapsed card): kept, saying nothing of the page.
    if (!now || now.hidden) return live && !now && !x.offPage ? null : 'current' in x ? { ...x, current: null } : x;
    const out = { ...x };
    if ('current' in x) out.current = now.shared ? null : now.current ?? null;
    if ('options' in x) out.options = now.options ?? [];
    return out;
  };
  return frames.map((f) => {
    const out = { ...f };
    for (const k of ['unknown', 'failed', 'noData', 'leftRequired', 'checks']) if (Array.isArray(f[k])) out[k] = f[k].map(fresh).filter(Boolean);
    if (Array.isArray(f.kept)) out.kept = f.kept.map((x) => (x.differs ? fresh(x) : answer(x, false))).filter(Boolean);
    if (Array.isArray(f.filled)) out.filled = f.filled.map((x) => answer(x, true));
    return out;
  });
}

// The report shown, checked against its page as it is now (liveItems, one message for every item):
// an item whose question has gone from the page (and isn't one the fill knew off screen) leaves the
// list (`gone`, hidden: back if the page draws it again) and holds nothing, Continue included; the
// others say what the page shows and offers now. Only on the report's own tab and page, never while a
// fill runs; an item already settled (answered, picked, marked done) stays as it is.
async function checkItems() {
  const entry = state.reportFor;
  const here = () => !state.filling && state.reportFor === entry && entry.tabId === state.tab?.id && pageOf(state.tab?.url) === entry.page;
  if (!entry?.fields || !here()) return;
  const rows = (entry.list ?? []).filter((r) => r.type === 'need' && r.key && !r.settled);
  // The answers listed, with the rule that answered each.
  const answers = (entry.list ?? []).filter((r) => r.type === 'answer' && r.key);
  if (!rows.length && !answers.length) return;
  const asked = [...rows.map((r) => ({ key: r.key, label: r.field || null })),
    ...answers.map((r) => ({ key: r.key, label: r.field || null, stepId: stepOf(r) }))];
  const live = await liveItems(entry.tabId, entry.carrier ?? state.tab.carrier, asked, entry.plan);
  if (!live || !here()) return;
  // An answer whose field is gone has no row (back if the page draws it again); one whose field shows
  // something else now shows that, as the page's (its tag said so where the fill wouldn't call it its
  // answer any more).
  for (const r of answers) {
    const now = liveOf(live, r.key, r.field ?? '');
    r.gone = !now && !r.offPage;
    if (now && !now.shared && now.shown != null && looseText(now.shown) !== looseText(r.value)) {
      r.value = now.shown;
      r.changed = null;
      if (now.agrees === true) { if (r.head) r.head = { ...r.head, value: now.shown }; }
      else setHead(r, { icon: '•', value: now.shown, tag: { kind: 'page', text: 'Changed on the page', title: 'Not the fill’s answer: the page shows this now' } });
    }
    drawRow(r);
  }
  let changed = false;
  for (const r of rows) {
    if (r.settled) continue;
    const now = liveOf(live, r.key, r.field);
    const gone = !now && !r.offPage;
    // In the page but not shown (a collapsed card): kept, saying nothing of what it shows.
    showLive(r, now?.hidden ? null : now);
    if (gone !== r.gone) {
      r.gone = gone;
      if (gone && r.open) toggleRow(r, false);
      changed = true;
    }
    drawRow(r);
  }
  if (changed) recount();
}
// An answer's rule (its plan step's id), as the kit is asked about it.
function stepOf(rec) { return rec.stepId == null || rec.stepId === '' ? null : String(rec.stepId); }

// checkItems once the page has been quiet a moment (the recorder's changes come in bursts).
function scheduleCheckItems() {
  clearTimeout(state.itemsTimer);
  state.itemsTimer = setTimeout(() => { checkItems(); }, 300);
}

// The page in front changed under the report shown, as the recorder saw it (answers, questions drawn
// or gone, a step or page shown): its items are checked against it again (checkItems). Registered
// beside onRecorderMessage; it answers nothing.
function noteLiveItems(msg, sender) {
  if (msg?.ra !== 'usage' || sender?.tab?.id !== state.tab?.id || !state.reportFor?.fields) return;
  if (['field_changes', 'new_fields', 'removed_fields', 'step_shown', 'page_view'].includes(msg.event)) scheduleCheckItems();
}

// An item left for the agent that is settled now (settleRow): answered on the page ('answered'), put
// in from its row ('picked', with what the page shows), or marked done ('marked', with `undo`).
function settleNeed(rec, how, undo = null, value = null) {
  const node = rowNodes.get(rec);
  const focused = !!node?.contains(document.activeElement);
  settleRow(rec, how, undo, value);
  drawRowNow(rec);
  // Keyboard focus stays on the item: on its Undo, or on its row.
  if (focused) (node.querySelector('.need-note button') ?? node.querySelector('.row-head') ?? node).focus();
  recount();
}

// The agent changed questions on the page (the recorder's field_changes: { key, label, after }, `after`
// what it holds now): their items in the page's list are settled, and an answer the fill put in that
// they changed is theirs now, when the report shown is this page's. Rows of one repeated question
// share its key (one per vehicle or driver): one of those is matched by its label too, and left as
// it is when the change doesn't say which.
function answeredOnPage(page, changes) {
  if (!changes.length || pageOf(state.tab?.url) !== page || !state.reportFor?.fields) return;
  const list = state.reportFor.list ?? [];
  for (const item of list.filter((r) => r.type === 'need')) {
    const change = changes.findLast((c) => c.key === item.key);
    if (change && item.settled !== 'answered') settleNeed(item, 'answered', null, change.after || null);
  }
  const rows = list.filter((r) => r.type === 'answer' && r.key);
  for (const row of rows) {
    const shared = rows.some((r) => r !== row && r.key === row.key);
    const change = changes.findLast((c) => c.key === row.key && (!shared || c.label === (row.field ?? '')));
    if (!change?.after) continue;
    row.value = change.after;
    row.changed = null;
    setHead(row, { icon: '✓', value: row.value, tag: { kind: 'you', text: 'You', title: 'You changed it on the page: no fill puts it back' } });
    drawRow(row);
  }
}

// Looks right: the agent approved the page as it stands now. Its receipt (pagekit receipt: a
// fingerprint of every answer on the page, no values) goes with a fill that clicks Continue only
// if the page still matches it then; a page that changed meanwhile is held again. Only for the page
// in front, and never while a fill runs.
async function lookRight(tabId, page, carrier, button = null) {
  const again = () => { if (button) button.disabled = false; };
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) { again(); return; }
  let confirmed = null;
  try {
    const frames = await runKit(tabId, carrier, () => globalThis.__raterKit?.receipt?.() ?? null, []);
    confirmed = frames.find((f) => f.frameId === 0)?.result ?? null;
  } catch { /* the page is navigating */ }
  if (!confirmed || state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) {
    again();
    if (!confirmed) announce('Couldn’t read the page. Try Looks right again.');
    return;
  }
  await fillPage({ confirmed });
}

// Whether the page still shows the answers the fill put in (pagekit readBack: reads only). A row
// whose field shows something else now (the carrier's server, or the agent) says what; one whose
// field isn't on the page now (a closed section) is left as it was. Only for the page in front.
// `list`: the report's rows; `plan`: the fill's plan, so the kit judges each answer as fill does
// (readBack `agrees`).
async function checkAnswers(list, tabId, page, carrier, plan = []) {
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const rows = list.filter((r) => r.type === 'answer' && r.key);
  if (!rows.length) return;
  const items = rows.map((r) => ({ key: r.key, label: r.field || null, stepId: stepOf(r) }));
  const ids = new Set(items.map((x) => x.stepId).filter(Boolean));
  const steps = (plan ?? []).filter((s) => ids.has(String(s.id)));
  let frames;
  try {
    frames = await runKit(tabId, carrier, (asked, filledBy) => globalThis.__raterKit?.readBack?.(asked, filledBy) ?? [], [items, steps]);
  } catch { return; /* the page is navigating */ }
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const now = new Map(frames.flatMap((f) => Array.isArray(f.result) ? f.result : []).map((x) => [`${x.key}|${x.label ?? ''}`, x]));
  // Spacing, case and punctuation aside: a phone number the page formats on blur is the same.
  const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const r of rows) {
    const x = now.get(`${r.key}|${r.field ?? ''}`) ?? now.get(`${r.key}|`);
    if (!x) continue;
    // The kit's word first (an address the page rewrote in its own format is the same answer);
    // without it, the text. An unticked box we left unticked reads back 'unchecked' (and empty).
    const differs = x.agrees === true ? false : loose(x.shown) !== loose(r.value);
    r.changed = differs ? `Now on the page: ${x.shown || 'empty'}` : null;
    drawRow(r);
  }
  const changed = rows.filter((r) => r.changed).length;
  if (changed) announce(`${changed} answer${changed === 1 ? '' : 's'} on the page changed since the fill.`);
}

// Reads the answers of the report shown back from the page (checkAnswers): when the agent looks at
// what is in (the Filled filter, step 3) and when the fill holds Continue for their check.
function refreshAnswers() {
  const entry = state.reportFor;
  if (entry?.fields && entry.tabId === state.tab?.id) checkAnswers(entry.list ?? [], entry.tabId, entry.page, entry.carrier ?? state.tab.carrier, entry.plan);
}

// After a fill: the page's answers in one list, in the order of their fields on the page. Each
// answer that went in says what and where it came from (the intake, worked out from it, a TNI
// standard, the agent, the page) and opens to its source, Change answer and See in intake; each
// item left for the agent says why, and offers its choices where the panel may put the agent's
// pick in (agentPickable), or Show on page and Mark done. The report is the fill's own tab and
// page's (`ctx`; the tab in front when none is given), kept for it while another one is in front.
function renderReport(frames, ctx = {}) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const fields = frames.reduce((n, f) => n + (f.fields ?? 0), 0);
  const tabId = ctx.tabId ?? state.tab?.id;
  const page = ctx.page ?? pageOf(state.tab?.url);
  const carrier = ctx.carrier ?? state.tab?.carrier;
  const maps = tabMaps(tabId);
  // The one-address application's step this fill was on, for the page strip and the report's key.
  const step = knownStep(carrier, frames.find((f) => f.stepKey)?.stepKey);
  // A report made again on reopen (restoreReports) is an earlier step's: the tab's step stays.
  if (step && !ctx.restoredAt) state.tabSteps.set(tabId, step);
  const key = ctx.keptKey ?? reportKey(tabId, page, carrier, ctx.active ?? state.active);
  // Kept for the panel opened again (keepReport); one made again from what was kept isn't, nor
  // one that says nothing while its page is filled again.
  const keep = () => { if (!ctx.restoredAt) keepReport(tabId, { key, page, active: { ...(ctx.active ?? state.active) }, at: Date.now(), stopped: !!ctx.stopped,
    // What earlier passes on this page filled, for the report shown again (restoreReports).
    filledBefore: Object.fromEntries(frames.flatMap((fr) => fr.kept ?? []).filter((x) => maps.filled?.get?.(x.key)).map((x) => [x.key, maps.filled.get(x.key)])), frames }); };
  // A page of tiles only (Most Common Vehicles) has no fields but may still need the agent.
  if (!fields && !all('actions').length && !all('noData').length) {
    // A step the kit couldn't read pauses nothing (rememberFill): its reason alone.
    const halted = frames.find((f) => f.halted && !f.stepUnread) ?? frames.find((f) => f.halted);
    // Still drawing, or Continue not there yet: filled again in a moment (rememberFill), nothing
    // said until then (W43-40, W43-42).
    if (!halted && ctx.retrying) { renderSteps(); return; }
    keep();
    // A page with no question for the fill (a unit list, every unit on it) is done: its dock offers
    // Continue (`empty`, W43-40). One that should have some (notDrawn) still has none, unless a frame
    // reached Continue (held, clicked, or due): a frame that found none of the page's questions
    // (Progressive's hidden frame) doesn't speak for a page the top frame has judged (live recording,
    // 2026-10-24: the vehicle list, every vehicle on it, read "No questions found" with only Fill this
    // page again, where Looks right was due).
    const judged = frames.some((f) => f.held || f.advanced || f.advanceDue);
    putReport({ key, tabId, page, at: ctx.restoredAt ?? Date.now(), ...(ctx.restoredAt ? { restored: true } : {}), ...(halted
      // A panel opened again doesn't keep the pause: a report made again doesn't say it.
      ? { error: `${halted.stepUnread || ctx.restoredAt ? '' : 'Automatic filling and helpers paused. '}${halted.reason ?? 'Review this page before retrying.'}` }
      : frames.some((f) => f.notDrawn) && !judged ? { notice: 'No questions found on this page.' }
        : { notice: 'Nothing to fill on this page.', empty: true, advanced: frames.find((f) => f.advanced)?.advanced ?? null,
          held: frames.some((f) => f.advanced) ? null : frames.find((f) => f.held)?.held ?? null }) }, []);
    renderSteps();
    return;
  }
  keep();
  // Each answer with its frame's place among the page's frames, as each item (itemsLeft).
  const framed = (k) => frames.flatMap((f, frame) => (f[k] ?? []).map((x) => ({ ...x, frame })));
  // An answer whose field the page no longer has (`gone`: pagekit reconcile, liveFrames) has no row:
  // the list shows only what is on the page.
  const filled = framed('filled').filter((x) => !x.otherStep && !x.gone);
  const kept = framed('kept').filter((x) => !x.otherStep && !x.gone);
  const items = itemsLeft(frames);
  const onPage = (x) => Number.isInteger(x.order);
  const needs = [...items.filter(onPage).sort((a, b) => a.frame - b.frame || a.order - b.order), ...items.filter((x) => !onPage(x))];
  const waiting = all('blocked');
  const advanced = frames.find((f) => f.advanced)?.advanced;
  // Buttons not clicked for something open over them on the page (pagekit `coveredHelpers`, a
  // helper's words; `covered`, Continue).
  const covered = [...new Set(frames.flatMap((f) => [...(f.coveredHelpers ?? []), ...(f.covered ? ['Continue'] : [])]))];
  // A page note may depend on the intake (Progressive's Rates for an NTL quote).
  const pageNote = carrier?.agentPages?.[page];
  const agentPage = typeof pageNote === 'function' ? pageNote(state.intake?.record ?? {}) : pageNote;
  // Answers an earlier pass on this page filled (a follow-up pass, after the VIN lookup or a
  // redraw, finds them already there): still ours, shown as filled.
  const before = ctx.filledBefore ? new Map(Object.entries(ctx.filledBefore)) : maps.filled;
  const earlier = kept.filter((x) => !x.differs && before?.get?.(x.key));
  const { fromOf, groupOf, ticks, editedBy } = answerSources(ctx.plan);
  const doneRows = groupRows([
    // `key`/`field`: the field and its label on the page, for checking the answer is still there
    // (checkAnswers) and changing it (changeAnswer); `kind`: what it is when it's no answer of ours.
    // Its value is what the page shows (`now`), not what the fill put in; one the page or the agent
    // changed since (`changed`) is theirs, not counted as the fill's ('changed', 'yours').
    ...filled.map((x) => ({ label: x.label || x.name, value: x.now ?? x.shown ?? '', standard: isStandard(x, 'filled'), path: x.path, from: fromOf.get(x.stepId), edited: editedBy(x.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId,
      answer: !x.changed, ...(x.changed ? { kind: x.changed === 'you' ? 'yours' : 'changed' } : {}), key: x.key, field: x.label ?? null, q: x.q ?? null, offPage: x.offPage ?? null, frame: x.frame, order: x.order })),
    ...earlier.map((x) => {
      const was = before.get(x.key);
      return { label: x.label || x.name, value: x.now || was.shown || 'filled', standard: isStandard(x, 'kept') || !!was.standard, path: was.path, from: fromOf.get(x.stepId), edited: editedBy(was.path, fromOf.get(x.stepId)), group: groupOf.get(x.stepId), stepId: x.stepId, answer: true, key: was.shown ? x.key : null, field: x.label ?? null, q: x.q ?? null, offPage: x.offPage ?? null, frame: x.frame, order: x.order };
    }),
    ...all('actions').map((x) => ({ label: 'Clicked', value: x.text || x.id, kind: 'clicked' })),
    ...kept.filter((x) => !x.differs && !earlier.includes(x)).map((x) => ({ label: x.label || x.name, value: 'left as the page had it', standard: isStandard(x, 'kept'), group: groupOf.get(x.stepId), stepId: x.stepId, kind: 'page', frame: x.frame, order: x.order })),
    ...all('skipped').map((x) => ({ label: x.label, value: 'yours, not filled', kind: 'yours' })),
  ], ticks);
  const count = doneRows.filter((row) => row.answer).length;
  // The carrier probably changed this page (pagekit: a known field renamed, or most questions
  // unfamiliar). The rest still filled; Continue waits for the agent.
  const renamedNames = all('renamed').map((x) => '"' + x.name + '"').join(', ');
  const pageChanged = frames.some((f) => f.pageChanged)
    ? (carrier?.name ?? 'The carrier') + ' seems to have changed this page: ' + all('unknown').length + " question(s) aren't known"
      + (renamedNames ? ', and ' + renamedNames + " moved to a field the extension doesn't know" : '')
      + ". They're left for you and Continue waits. Please report it (a Capture page layout helps)."
    : null;
  // Held for the agent's check (Let me look before Continue): the top frame's word.
  const held = advanced ? null : frames.find((f) => f.held)?.held ?? null;
  const stopped = !!ctx.stopped;
  // `halted`: the fill stopped short ("Filling stopped" above the list, or the agent's Stop).
  const entry = { key, tabId, page, step: step ?? null, carrier, plan: ctx.plan ?? [], fields, filled: count, left: needs.length, otherLeft: needs.filter((x) => !finishLeftOk(carrier, x)).length, waiting: waiting.length, covered: covered.length, advanced: advanced ?? null, held, at: ctx.restoredAt ?? Date.now(), auto: !!ctx.auto, stopped,
    halted: frames.some((f) => !!f.halted),
    ...(ctx.restoredAt ? { restored: true } : {}) };
  // The answers and the items in one list, by their place on the page: an item without a field on
  // the page (a helper, a unit without its row) after them, then answers without one (a click).
  const listed = [...doneRows.map((row) => ({ row, at: row })), ...needs.map((x) => ({ x, at: x }))];
  const ordered = [...listed.filter((e) => onPage(e.at)).sort((a, b) => a.at.frame - b.at.frame || a.at.order - b.at.order),
    ...listed.filter((e) => !onPage(e.at) && e.x), ...listed.filter((e) => !onPage(e.at) && e.row)];
  const first = ordered.find((e) => e.x);
  const rctx = { tabId, page, carrier };
  // Each row as data (report-rows.js), the first item open: what is left, the filters and the dock
  // read them; the panel changes them and drawRow draws them.
  entry.list = ordered.map((e) => (e.x ? needRecord(e.x, carrier, page, e === first) : answerOf(e.row)));
  const halted = frames.find((f) => f.halted);
  const nodes = [
    // An agent page's note: a yellow box on a page that needs more attention (`warnPages`:
    // Progressive's NoHit, W44-14), a line of text on the others.
    agentPage ? (carrier?.warnPages?.[page] ? issueCard({ tone: 'warn', title: carrier.warnPages[page], text: agentPage })
      : h('p', { class: 'note-line agent-page' }, agentPage)) : null,
    // An answer picked in place of one the page doesn't offer (pagekit `orMost`: GEICO's pay plan
    // with no 11 Payments, W43-32): named here; nothing is left for the agent by it.
    ...filled.filter((x) => x.said).map((x) => h('p', { class: 'note-line said' }, x.said)),
    // Not clicked through what is open over them (Continue, a helper), which the agent closes.
    !advanced && covered.length
      ? issueCard({ tone: 'warn', title: `${covered.length > 1 ? `${covered.slice(0, -1).join(', ')} and ${covered.at(-1)} weren’t` : `${covered[0]} wasn’t`} clicked`,
        text: `Close what is open over ${covered.length > 1 ? 'them' : 'it'}, then fill again.` }) : null,
    halted ? (stopped
      ? issueCard({ tone: 'quiet', title: 'You stopped the fill', text: 'Nothing more was filled or clicked. What went in stays.' })
      : issueCard({ title: 'Filling stopped', text: `${halted.reason ?? ''} Check the page, then fill again.`.trim(), role: 'alert' })) : null,
    pageChanged ? issueCard({ title: 'This page seems to have changed', text: pageChanged, role: 'alert' }) : null,
    advanced ? h('div', { class: 'done-card' }, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('b', {}, 'This page is done'),
      h('span', {}, `${count} answer${count === 1 ? '' : 's'} in. Clicked “${advanced}” for you.`)) : null,
    // The AI's messages, and what it suggests without a row, go here, above the list (runAssist).
    h('div', { class: 'needs-head', hidden: true }),
    // Buttons waiting on others (Progressive's bill plan before Recalculate) aren't listed: the fill
    // clicks them in turn, and a question one waits on is a row. The fill log keeps them (blockerList).
    entry.list.length ? rowsHost(entry, rctx) : null,
  ].filter((node) => node != null && node !== false);
  if (key === currentReportKey()) state.filter = 'all';
  putReport(entry, nodes);
  renderSteps();
  if (state.reportFor !== entry || ctx.restoredAt) return;
  announce(`Filled ${count} answer${count === 1 ? '' : 's'}. ${needs.length ? `${needs.length} left for you.` : held ? 'Check the answers, then click Looks right.' : 'Nothing is left for you.'}`);
  if (held) refreshAnswers();
}

// The node React drew for each row (report-view.jsx), for the focus and scrolling that follow a
// change, and the slot on an item's row where the AI's card goes: drawn by the AI (renderAi), not
// by React.
const rowNodes = new WeakMap();
const aiSlots = new WeakMap();

// An answer's row (answerRecord) with where it came from, as the row says it (answerSource).
function answerOf(row) {
  const rec = answerRecord(row);
  rec.source = answerSource(rec);
  return rec;
}

// Where an answer came from, as its row says it, worked out as the row is made: its source tag
// (none for one from the intake, the usual source, said to screen readers only: `quiet`, so the
// others stand out), the title and quote its row opens to, and its place on the intake PDF (See in
// intake): the field an answer came from, or those a derived one was worked out from. A TNI
// standard is no intake fact; no place while the PDF isn't kept.
function answerSource(rec) {
  const { kind } = rec;
  const pdfHere = pdfAvailable();
  const paths = [].concat(rec.from ?? rec.path ?? []);
  const place = ['intake', 'derived', 'edited'].includes(kind) && pdfHere && state.intake && paths.length ? sourcePlace(paths, state.intake) : null;
  const tag = {
    intake: { kind: 'intake', text: `Intake${place ? pdfPageSaid(place.page, ' p.') : ''}`, title: 'From the intake' },
    derived: { kind: 'derived', text: 'Worked out', title: 'Worked out from intake answers' },
    standard: { kind: 'standard', text: 'TNI standard', title: 'A TNI standard answer, not a fact from the intake' },
    edited: { kind: 'you', text: 'Your edit', title: 'From your correction in the panel' },
    page: rec.standard ? { kind: 'standard', text: 'TNI standard', title: 'The page already had the TNI standard answer' } : { kind: 'page', text: 'On the page', title: 'The page already had it' },
    clicked: { kind: 'clicked', text: 'Clicked', title: 'Clicked for you' },
    yours: { kind: 'you', text: 'You', title: 'Your answer: no fill changes it' },
    changed: { kind: 'page', text: 'Changed on the page', title: 'Not the fill’s answer: the page shows this now' },
  }[kind];
  const fmt = (v) => (v === true ? 'Yes' : v === false ? 'No' : v == null || v === '' ? 'not on the intake' : String(v));
  const said = (path) => `${fieldInfo(path).label}: ${fmt(get(state.intake?.record ?? {}, path))}`;
  const [title, quote] = {
    intake: [`Intake${place ? pdfPageSaid(place.page, ', page ') : ''}`, rec.path ? said(rec.path) : `Answer: ${rec.value}`],
    derived: ['Worked out from the intake', (rec.from ?? []).map(said).join(' · ')],
    standard: ['TNI standard answer', `Answer: ${rec.value}`],
    edited: ['Your correction in the panel', rec.path ? said(rec.path) : `Answer: ${rec.value}`],
    page: ['Already on the page', 'The fill left it as the page had it.'],
    clicked: ['Clicked for you', `“${rec.value}”`],
    yours: ['Your answer', 'You changed it on the page, so no fill puts it back.'],
    changed: ['Changed on the page', 'The page shows this now, not the answer the fill put in. Check it.'],
  }[kind];
  return { tag: kind === 'intake' ? null : tag, quiet: kind === 'intake' ? tag.title : null, title, quote, place,
    seeTitle: kind === 'edited' ? 'Show what the intake said before your edit' : kind === 'derived' ? 'Show the intake answers this was worked out from' : 'Show where this came from in the intake' };
}

// The report's list of answers and items (renderReport), drawn by React from the report's records
// (report-view.jsx), its buttons doing what rowActs says, on the report's own tab and page (`ctx`).
function rowsHost(entry, ctx) {
  const host = h('div', { class: 'rows' });
  entry.unmountRows = mountRows(host, entry, ctx, rowActs);
  return host;
}

// Follow-up answers on the report shown (autoFill), at the end of its list, marked new: a list
// begun for them where the report had none.
function appendRows(rows, ctx) {
  const entry = state.reportFor;
  const recs = rows.map((row) => answerOf({ ...row, fresh: true }));
  entry.list = [...(entry.list ?? []), ...recs];
  if (entry.unmountRows) state.rowsDrawn = (state.rowsDrawn ?? 0) + 1;
  else $('report').append(rowsHost(entry, ctx));
  return recs;
}

// A row's record changed: the report's list draws it again (report-view.jsx), that row only.
function drawRow(rec) {
  rec.v = (rec.v ?? 0) + 1;
  state.rowsDrawn = (state.rowsDrawn ?? 0) + 1;
}
// drawRow, drawn before it returns: for the focus or scrolling that follows.
function drawRowNow(rec) { flushSync(() => drawRow(rec)); }

// The slot on an item's row where the AI's suggestion goes (renderAi), while the row is drawn.
function aiSlotOf(rec) { return aiSlots.get(rec) ?? null; }

// What a row's buttons do (report-view.jsx). Mark done: an item's field, or a helper's reminder by
// its helper's id (`action`: one the carrier marks markable, Progressive's Rates on an NTL quote with
// cargo); an item with neither has no Mark done. A pick on the AI's own choice accepts its
// suggestion (applyAi); Change answer's pick goes in as the agent's.
function markRow(rec, { tabId, page }) {
  const { x } = rec;
  if (x.key) return markDone(rec, x.key, tabId, page, x);
  if (x.action) return markActionDone(rec, x.action, tabId, page, x);
}
function showRow(rec, { tabId, page, carrier }) { return showOnPage(rec, rec.x, tabId, page, carrier); }
function pickRow(rec, choice, ctx, button = null) {
  if (rec.type === 'answer') return rec.change ? agentAnswer(rec, rec.change.x, choice, ctx, button) : undefined;
  return rec.aiAccept && choice === rec.aiPick ? rec.aiAccept(button) : agentAnswer(rec, rec.x, choice, ctx, button);
}
function seeRow(rec) { return openPdf({ path: rec.path, from: rec.from, label: rec.label, kind: 'filled' }); }
const rowActs = {
  toggleRow: (rec) => toggleRow(rec), markRow, showRow, pickRow, changeRow: (rec, ctx) => changeAnswer(rec, ctx), seeRow,
  node: (rec, el) => { if (el) rowNodes.set(rec, el); else rowNodes.delete(rec); },
  slot: (rec, el) => { if (el) aiSlots.set(rec, el); else aiSlots.delete(rec); },
};

// Opens a row of the page's list in place (closing the one open before), or closes it.
function toggleRow(rec, open = !rec.open) {
  if (open) {
    for (const other of state.reportFor?.list ?? []) {
      if (other === rec || !other.open) continue;
      other.open = false;
      drawRow(other);
    }
  }
  rec.open = open;
  drawRow(rec);
  renderDock();
}

// The dock's Show the next one: the next question still needing the agent after the one open now
// (the first when none is), opened in the whole list and brought into view.
function showNextNeed() {
  if (state.view !== 'page' || state.filter !== 'all' || state.pastKey) {
    state.view = 'page';
    state.filter = 'all';
    state.pastKey = null;
    showScreen();
    renderSteps();
  }
  const list = state.reportFor?.list ?? [];
  const open = list.filter((r) => r.type === 'need' && !r.settled && !r.gone);
  if (!open.length) return;
  const now = list.find((r) => r.open);
  const next = (now && open.find((n) => n !== now && list.indexOf(n) > list.indexOf(now))) || open.find((n) => n !== now) || open[0];
  flushSync(() => toggleRow(next, true));
  const node = rowNodes.get(next);
  node?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  node?.querySelector('.row-head')?.focus({ preventScroll: true });
}

// Change answer on a row that went in: the choices the page offers now, put in for the agent from
// the row (agentAnswer); a typed answer, or one the panel may not answer, is shown on the page for
// the agent to change there (showOnPage), where their answer then stays theirs.
async function changeAnswer(rec, { tabId, page, carrier }) {
  if (state.filling || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  if (rec.change) { rec.change = null; drawRow(rec); return; }
  let frames = null;
  try { frames = await runKit(tabId, carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null)); } catch { /* the page is navigating */ }
  if (state.tab?.id !== tabId || pageOf(state.tab?.url) !== page) return;
  const matches = aiSnapshotFieldMatches(frames, { key: rec.key, label: rec.field });
  const field = matches.length === 1 ? matches[0].field : null;
  const x = field ? { key: field.key, label: field.label, section: field.section, controlKind: field.kind, q: rec.q ?? null, current: field.current,
    options: choicesOf(field.kind, field.options) } : null;
  if (!x || !agentPickable(x, carrier, page)) {
    rec.note = { text: 'Change it on the rater page. Your answer there stays: no fill puts this one back.', bad: false, undo: null };
    drawRow(rec);
    showOnPage(rec, { key: rec.key, label: rec.field }, tabId, page, carrier);
    return;
  }
  rec.change = { x, options: x.options, current: x.current };
  drawRowNow(rec);
  rowNodes.get(rec)?.querySelector('.change-slot')?.querySelector('button, select')?.focus();
}

// The agent's pick for a question, from its row (an item left for them, or Change answer): put in
// through the same guarded path as an AI answer (pagekit answerEdits and answer, `by: 'agent'`),
// only while the page still shows the question and the choice as the row read them, never on a
// stop step. The field then joins the agent's on this page, as their own edit there does: no fill
// changes it and Continue no longer waits on it. Logged as the agent's field change.
async function agentAnswer(rec, x, choice, { tabId, page, carrier }, button = null) {
  if (state.filling || state.closing || !state.intake || state.tab?.id !== tabId || pageOf(state.tab?.url) !== page || !agentPickable(x, carrier, page)) return;
  const say = (text) => { rec.note = { text, bad: true, undo: null }; drawRow(rec); };
  const intake = state.intake;
  const revision = state.intakeRevision;
  const scope = usage.currentSession()?.intakeId;
  const editOrigin = { scope, tabId, page: editScope(page, carrier), keys: state.agentKeys, epoch: state.agentKeysEpochs?.get(scope) ?? 0 };
  const current = () => state.tab?.id === tabId && pageOf(state.tab?.url) === page && state.intake === intake && state.intakeRevision === revision;
  const token = crypto.randomUUID();
  let field = null;
  let result = null;
  let guarding = false;
  let edited = [];
  state.filling = true;
  if (button) button.disabled = true;
  // Our own answer isn't the agent's change on the page: the recorder is paused, as for a fill.
  await tellRecorder('pause', tabId);
  try {
    guarding = true;
    await runKit(tabId, carrier, (t) => globalThis.__raterKit.answerEdits('begin', t), [token]);
    if (!current()) return;
    const frames = await runKit(tabId, carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null));
    if (!current()) return;
    const matches = aiSnapshotFieldMatches(frames, x);
    if (matches.length !== 1) { say('The page changed: answer it on the page.'); return; }
    const [{ frame }] = matches;
    field = matches[0].field;
    const options = choicesOf(field.kind, field.options);
    if (!options.includes(choice) || !agentPickable({ ...x, controlKind: field.kind, section: field.section, options }, carrier, page)) {
      say('The page doesn’t offer that answer now: answer it on the page.');
      return;
    }
    const answered = await runKit(tabId, carrier, (a, t, o) => globalThis.__raterKit.answer(a, null, t, o),
      [[{ key: field.key, label: field.label, value: choice, expected: { kind: field.kind, section: field.section, options, current: field.current } }],
        token, { stopSteps: Object.keys(carrier.stopSteps ?? {}), by: 'agent' }], [frame.frameId]);
    result = answered.flatMap((f) => f.result ?? []).find((r) => r?.key === field.key) ?? null;
  } catch {
    result = null;
  } finally {
    if (guarding) {
      try {
        const frames = await runKit(tabId, carrier, (t) => globalThis.__raterKit.answerEdits('end', t), [token]);
        // The agent's own edits while the answer went in stay theirs, as after a fill.
        edited = frames.flatMap((f) => f.result ?? []).filter((r) => r?.protected).map((r) => r.key);
      } catch { /* a removed or navigating frame no longer has live listeners */ }
    }
    await persistGuardedEdits(editOrigin, edited);
    await tellRecorder('resume', tabId);
    state.filling = false;
    if (button) button.disabled = false;
    // The recorder was paused: the questions the answer revealed or hid are read here.
    if (field && state.tab?.id === tabId) scheduleLayout(page, 'changed');
  }
  if (!field) return;
  if (!result?.ok) {
    if (current()) say(result?.reason ? `The page didn’t take it (${result.reason}). Answer it on the page.` : 'Couldn’t reach the page. Answer it on the page.');
    return;
  }
  const shown = result.shown || choice;
  // On the quote's finishing step after its action was clicked, the printed proposal is no longer the
  // quote on the page (noteChangedAfterDone): the recorder was paused, so no field_changes says so.
  if (noteChangedAfterDone(carrier, page, tabStep(carrier, tabId), tabId)) renderSteps();
  // In on the page, so the agent's from now on where it went in (no fill changes it) and logged with
  // the quote it went into, also when they moved to another tab, page or intake meanwhile.
  await persistGuardedEdits(editOrigin, [x.key]);
  if (!carrier.practice && usage.currentSession()?.intakeId === scope) {
    const maps = tabMaps(tabId);
    const ctx = { record: intake.record, filled: maps.filled, labels: maps.labels, choices: maps.choices,
      redact: redactor(redactionTerms(intake.record)), keySalt: usage.currentSession()?.keySalt, step: knownStep(carrier, tabStep(carrier, tabId)) };
    usage.log({ carrier: carrier.id, page, view: viewOf(tabId, page, carrier),
      ...fieldChangeEvent({ key: field.key, q: x.q ?? null, label: field.label, kind: field.kind, before: field.current ?? '', after: shown, agent: true }, ctx) });
  }
  if (!current()) return;
  // The question's other rows too: a filled answer with a check shows as an answer and as a check,
  // and a field may be listed twice (failed, and not on the intake). Rows of the report shown only
  // (a report kept for another page isn't changed).
  const label = x.label ?? field.label ?? '';
  const list = state.reportFor?.list ?? [];
  const same = list.includes(rec) ? list.filter((r) => r.key === x.key && (r.type === 'need' ? needId(r) : `|${r.field ?? ''}`).endsWith(`|${label}`)) : [];
  const rows = new Set([rec, ...same]);
  // The AI's word on it, if any, on whichever of its rows it went (renderAi puts it on the first;
  // review of #245): a suggestion the agent answered otherwise is dismissed (logged); a pick it put
  // in that waits for approval is the agent's answer now, as after an edit there.
  let taken = false;
  for (const sugg of new Set([...rows].map((r) => r.ai).filter(Boolean))) {
    if (![...state.aiCache.values()].includes(sugg)) continue;
    if (sugg.done === 'auto' && !sugg.approved && !sugg.manual) {
      sugg.manual = true;
      taken = true;
    } else if (!sugg.done && !sugg.dismissed) {
      sugg.dismissed = true;
      if (!carrier.practice) usage.log(aiDecisionEvent(sugg, { carrier, page }, 'dismissed'));
    }
  }
  if (taken) {
    persistAiPending();
    syncAiBanner({ tabId, page, carrier });
  }
  // Its rows say the agent's answer only: the AI's card goes, and its pick is no longer marked
  // among the choices or taken as accepting it (review of #245).
  for (const row of rows) {
    aiSlotOf(row)?.replaceChildren();
    row.aiPick = null;
    row.aiAccept = null;
  }
  if (rec.type === 'need') rec.pressed = choice;
  for (const row of rows) {
    if (row.type === 'need') { settleNeed(row, 'picked', null, choiceSaid(shown)); continue; }
    row.value = shown;
    row.changed = null;
    setHead(row, { icon: '✓', value: choiceSaid(shown), tag: { kind: 'you', text: 'You', title: 'Your answer, put in from the panel' } });
    row.change = null;
    row.note = { text: '✓ Put in for you. No fill changes it now.', bad: false, undo: null };
    drawRow(row);
  }
  // Questions the answer revealed are filled as after an edit on the page.
  scheduleAutoFill(page);
}

async function clearMarks() {
  if (!state.tab?.carrier) return;
  await runKit(state.tab.id, state.tab.carrier, () => globalThis.__raterKit.clear());
  const key = currentReportKey();
  dropReports((entry) => entry.key === key);
  renderSite();
}

// A developer's capture of the page as it is now, for writing rules and mock pages (docs/learning.md):
// its questions, choices, picks, messages and any open dropdown list, never typed text, client
// details redacted. Captures belong to a scenario and are numbered within it, so a series (an
// answer changed, then captured again) reads as before and after; `npm run captures` lists what
// changed between them. Downloaded only: nothing is uploaded. Alt+Shift+C takes one without
// leaving the page, e.g. with a dropdown open.
const captureCountsStore = inExtension
  ? { get: async () => (await chrome.storage.local.get('captureCounts')).captureCounts, set: (v) => chrome.storage.local.set({ captureCounts: v }) }
  : { get: async () => memory.captureCounts, set: async (v) => { memory.captureCounts = v; } };

// A scenario's next capture number, kept in the extension's settings (local storage, so a scenario
// continued after Chrome restarts carries on) and taken one at a time, also across panels in two
// windows (a Web Lock), so two quick captures never share a number.
async function nextCaptureNumber(scenario) {
  // Under its own storage key, not in the settings object other settings rewrite.
  const take = async () => {
    const counts = (await captureCountsStore.get()) ?? {};
    const n = (counts[scenario] ?? 0) + 1;
    await captureCountsStore.set({ ...counts, [scenario]: n });
    return n;
  };
  return globalThis.navigator?.locks ? navigator.locks.request('capture-counts', take) : take();
}

// Alt+Shift+C reaches the side panel of every window: only the one in the focused window captures.
// Popped out, the panel is the only copy and captures the tab it follows, wherever focus is.
async function captureFromShortcut() {
  if (!popped) {
    const [mine, focused] = await Promise.all([chrome.windows.getCurrent(), chrome.windows.getLastFocused()]).catch(() => [null, null]);
    if (mine && focused && mine.id !== focused.id) return;
  }
  capturePage();
}

// What a capture did, under its button in Settings (never over a fill report): state.captureStatus,
// which settings-view.jsx draws.
function captureSaid(text) {
  state.captureStatus = text;
}

async function capturePage() {
  if (!state.tab?.carrier) {
    captureSaid('Open a carrier page to capture its layout.');
    return;
  }
  // Client details are redacted with the loaded intake's names and numbers: without one, nothing
  // on the page or typed in the scenario and note would be.
  if (!state.intake?.record) {
    captureSaid('Load the intake first, so client details can be redacted.');
    return;
  }
  const { id: tabId, carrier } = state.tab;
  const record = state.intake?.record;
  const redact = redactor(redactionTerms(record));
  // Both are typed by the agent: a client's name or number in them is redacted like the page's.
  const scenario = redact($('capture-scenario').value.trim()).slice(0, 60) || 'unnamed';
  const typedNote = $('capture-note').value;
  const note = redact(typedNote.trim()).slice(0, 200) || null;
  // Which quote the scenario belongs to (its session's first characters, no client data): two
  // clients' scenarios redacted to the same name stay apart.
  const quote = String(usage.currentSession()?.id ?? '').slice(0, 8) || null;
  const page = pageOf(state.tab.url);
  const view = viewOf(tabId, page, carrier);
  // What the capture is of; checked again once the page has been read (as layout jobs are).
  const asked = JSON.stringify([tabId, page, state.active, state.intakeRevision, usage.currentSession()?.id ?? null]);
  try {
    const results = await runKit(tabId, carrier, (p, r) => globalThis.__raterKit.capture(p, r),
      [record ? buildPlan(record, carrier, state.active) : null, record ? redactionTerms(record) : []]);
    // Frames with questions, the top one, and any with messages or an open list (evidence only).
    const frames = results.map((r) => r.result).filter((f) => f && (f.controls.length || f.isTopFrame || f.messages?.length || f.openLists?.length));
    const top = frames.find((f) => f.isTopFrame);
    const now = JSON.stringify([state.tab?.id, pageOf(state.tab?.url), state.active, state.intakeRevision, usage.currentSession()?.id ?? null]);
    if (now !== asked || top?.page !== page) {
      captureSaid('The page changed during capture. Nothing saved; capture again.');
      return;
    }
    // Rater pages change with the state and product being quoted, so every capture records them.
    const context = record ? {
      state: record.garaging?.state ?? null,
      businessClass: record.operations?.businessClass ?? null,
      vehicleTypes: [...new Set(record.vehicles.map((v) => v.type).filter(Boolean))],
      hasTrailers: record.trailers.length > 0,
      coverages: Object.entries(record.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    } : null;
    const n = await nextCaptureNumber(`${quote ?? ''}|${scenario}`);
    const data = { tool: 'tni-rater-autofill', kind: 'page-capture', version: 2, carrier: carrier.id, capturedAt: new Date().toISOString(),
      // The step only for a one-address application (layoutSteps, AmWINS), as layouts do: other
      // carriers' headings change with the questions shown (a follow-up's own heading).
      scenario, quote, n, note, page: top?.page ?? page, step: (carrier.layoutSteps && top?.step) || null, view: view ?? null, context, frames };
    const slug = (s, max) => String(s ?? '').replace(/^https?:\/\/[^/]+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, max) || 'page';
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `capture-${carrier.id}-${slug(scenario, 30)}${quote ? `-${quote.slice(0, 4)}` : ''}-${String(n).padStart(3, '0')}-${slug(data.page, 30)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    // Only the note this capture took: one being typed for the next step stays.
    if ($('capture-note').value === typedNote) $('capture-note').value = '';
    captureSaid(`Saved capture ${n} of "${scenario}" (${frames.reduce((k, f) => k + f.controls.length, 0)} fields${top?.openLists?.length ? ', an open list' : ''}) to Downloads. Client details are [client]. Move it to layouts/ and skim it before sharing.`);
  } catch (e) {
    captureSaid(`Couldn't capture this page: ${e.message}`);
  }
}

export { afterFill, aiSlotOf, answerOf, answeredOnPage, appendRows, assistAfterFill, captureFromShortcut, capturePage, checkItems, clearMarks, drawRow, fillPage, liveFrames, liveItems, lookRight, noteLiveItems, noteMissingUnit, pickListItem, refreshAnswers, renderReport, runKit, showNextNeed, unitArrival, worldFor };
