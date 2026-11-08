// @ts-check
// Multi-round cursor execution engine: pass management, control judgement, helper verification, post-fill reconciliation, and result resolution.

import { oneLine, squash, loose } from "./text.js";
import {
  adapter, currentPage, stepKey, stepIs, stopStepOn,
  addStopSteps, pageAt, pageBusy, stepBars, perfNow, recentRequests, setComponentPrefix, watchRequests, watchingRequests, settle,
  pause, stopWaitsWhen, INTERRUPTED, ratesStale, premiumReady, rated,
} from "./adapter.js";
import {
  deepQueryAll, buttonText, collectControls, fieldKey, optionsOf,
  describe, hasValue, selectedText, invalidControl, shownNow,
  safeMatches, shownControl, otherStep, legendWords, REVIEW_LISTS, setNativeValue, setHiddenOk,
  getControlReads, keyIndex, controlOf, hiddenKeys,
} from "./dom.js";
import {
  COVERED, COVERED_HELPER, CLOSED_SECTIONS,
  findAdvanceButton, findButton, pressButton, coveredBy, agentPress,
} from "./actions.js";
import { mark, clear } from "./marks.js";
import { makePager, setFillUnits, getFillUnits, setKnownUnitMarkers, unitFormsNow } from "./units.js";
import { guardEdits, EDIT_HALT, STOP_HALT, STOP_STEP_HALT, STEP_UNREAD_HALT } from "./guard.js";
import { kitTrace, isTracing } from "./trace.js";
import { receipt, signature } from "./capture.js";
import {
  assign, matchOption, holdingCondition, moneyTokens, businessNameKey, uniqueBusinessNames,
  heldFormNote, unitName, unitNoun, unmatchedRowNote, witnessName, apply, agreesWith, looseMatch, looseNote,
  summaryAccepted, waitedOut, unpicked, waitedOutUndrawn, WAIT_MS, WAIT_ROUND_MS,
  AFTER_WAIT_QUIET_MS, LOAD_MS, LOAD_RESULT_MS, LOAD_QUIET_MS, LOAD_HALT, KEPT_WATCH_MS, FILL_BUDGET_MS, BUDGET_HALT,
  ONCE_UNVERIFIED, NOTHING_LEFT, AGENT_PRESSED, CONTINUE_REFUSED, RESET_QUIET_MS,
} from "./apply.js";
import { itemResolution, LIST_STATUS } from "../resolution.js";

/** @import { FailCode, FillOptions, FillReport, PlanStep, UnitPager } from "../../types.js" */
/** @import { PageControl } from "./dom.js" */

export const getRunning = () => running;


let running = null;
// The running fill stopped (Stop, or the agent's edit): every wait of the kit's ends at its next
// wake (adapter.js settle and pause), the driver's too, and nothing more is written or clicked.
// Its time in all spent (`budgetMs`) stops it there too, read at every answer and wait, so a page
// that blocks past the deadline gets no answer more before the timer runs (CodeRabbit on #398).
stopWaitsWhen(() => !!running && (running.report.halted || running.timeUp()));
// Fills the agent stopped before they began here (`run`: the panel's id for the fill; Stop can
// come while the panel still prepares, before fill() starts): such a fill halts as it starts.
const stoppedRuns = new Set();
// The page a fill left settled as it ended, on a page that waits on its server (Progressive): a
// helper (Add Vehicle, Cargo Van, View bill plan options) opened the next page and the fill's wait
// held until that page and its requests were done. The next fill, a moment later, finds the same page,
// its questions and nothing busy, so it waits for a short quiet only (`START_SETTLED_QUIET_MS`).
// Two Progressive recordings, 2026-11-04: on all such starts the page did nothing in the 400 ms.
let settledAt = null;
const SETTLED_FRESH_MS = 1500;

// The top frame's page as it is now: null where it can't be read (another origin's frame).
const topPageNow = () => { try { return pageAt(window.top.location); } catch { return null; } };
const START_SETTLED_QUIET_MS = 100;
// This frame's kit and the filled lists it has sent rows of (progress).
const FRAME = Math.random().toString(36).slice(2);
const listIds = new WeakMap();
let lastListId = 0;
// `seen`: how many rows the panel has, by list (`list`: this frame's id and the filled list's
// own, which a rewrite of the list, an answer given again, changes). Only the rows after those
// are sent (`since`); a list the panel hasn't seen, whole.
export function progress(seen = null) {
  if (!running) return null;
  const all = running.report.filled;
  if (!listIds.has(all)) listIds.set(all, ++lastListId);
  const list = `${FRAME}:${listIds.get(all)}`;
  const had = Number(seen?.[list]) || 0;
  const since = had > 0 && had <= all.length ? had : 0;
  // Each row with its place on the page as the last round read it (`order`), so the panel lists the
  // answers and the items in the page's order.
  const placeOf = running.places ?? (() => null);
  const rows = all.slice(since).map((x) => ({ key: x.key ?? null, label: x.label || x.name || '', shown: x.shown ?? '', standard: !!x.standard,
    stepId: x.stepId ?? null, path: x.path ?? null, otherStep: !!x.otherStep, order: placeOf(x) }));
  // The items judged so far (the fill's streamItems: one snapshot a round), only when the panel
  // doesn't have this round's (`seen['items@<frame>']`).
  const items = running.items ?? null;
  const fresh = !!items && Number(seen?.[`items@${FRAME}`]) !== items.at;
  return { frame: FRAME, list, filled: all.length, since, rows, phase: running.phase ?? null, itemsAt: items?.at ?? 0, ...(fresh ? { items: items.list } : {}) };
}
export function stop(run = null) {
  if (run != null && (!running || running.run !== run)) stoppedRuns.add(run);
  if (!running) return false;
  running.halt(STOP_HALT);
  return true;
}

// Each report item's resolution, as the fill returns: the answer, how it was decided, why, and
// what it needs, from its list and its own fields (src/resolution.js itemResolution). The panel
// and the AI read it.
export function resolveItems(report, plan) {
  const values = new Map(plan.filter((s) => s.kind !== 'action').map((s) => [s.id, s.value]));
  for (const list of [...Object.keys(LIST_STATUS), 'checks']) {
    for (const x of report[list] ?? []) x.resolution = itemResolution(x, list, values.get(x.stepId));
  }
}


// ---------------------------------------------------------------------------------------------
// Public API

// Fills in rounds: each round re-reads the page, handles every step that now has a field, and
// on pages that talk to their server after each answer (ExtJS/Duck Creek) stops after one
// answer and waits. New questions that appear because of an answer get picked up next round.
// `skip`: field keys to leave alone (ones the agent changed; used by automatic follow-up fills).
// `doneActions`: button actions already clicked earlier in this quote.
// `replaceChoices`: a dropdown/radio/checkbox answer the page pre-selected (not the agent) is
// replaced when it differs from ours; agent changes are protected by `skip`.
// `visitedPages`: pages already seen in this quote (for actions that wait on a page).
// `advance`: { text, pages, exceptPages, steps, notWithin, byForm, quietMs } — when the page ends with nothing for
// the agent to look at (no unfamiliar required fields, nothing missing, nothing failed), click its
// Continue button. `pages`: only on these pages (Progressive's). `steps`: on a one-address
// application, only on these steps (GEICO's, up to Additional Business Info; AmWINS' before
// Underwriting). A carrier's advance always has one or the other (src/units.js advanceFor: without
// either, no Continue). `notWithin`: no button inside this. `byForm`: a step that shows
// several forms and lists in turn (GEICO's Vehicles: each unit's form, then the list) is continued
// per form and button, not once a step: `report.advanceKey` is the step, the button's words and the
// unit form on screen ("Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_63452"), which
// `doneSteps` then holds. `quietMs`: on a page that isn't ExtJS, the page is quiet this long
// before Continue: a fill that gave answers waits for that before it ends (on `steps`) and answers
// what the page drew meanwhile, and a question drawn after that without an answer holds Continue.
// `batch`: for pages whose answers never wait on a server (AmWINS): every answer the round can
// see is given in one pass and checked on the spot, with one wait for the page per round
// instead of one per answer. What an answer reveals or redraws is picked up next round, and
// anything the page changes later is given again (see `refill`).
// `doneSteps`: steps of a one-address application (stepKey) already continued from: a step the
// agent goes back to is theirs, never continued again.
// `stopPages`: pages where the carrier has stopped the quote: nothing is filled or clicked there.
// `stopSteps`: steps of a one-address application that are the agent's (GEICO's MVR & CLUE), by
// name: the same, read from the page as the fill starts and again every round (the agent's Next
// changes the step without a new address).
// `units`: { active, count, bound } per list (vehicles, drivers, trailers): the unit the plan is
// for, how many the intake lists, and the unit forms earlier fills answered each unit on (form id
// -> index). A form that may be another unit's is held (report.unitHeld); one the plan gives an
// answer for is report.unitForm, for the panel to bind to the active unit.
// `skipBy` (form-scoped carriers: GEICO): the agent's edits by where they were made, { steps:
// { step: keys }, units: { list: keys } (the active units'), forms: { form id: keys }, stepUnits:
// { step: list } }. Each round skips, besides `skip`, those of the step and forms on screen
// (skipWhere).
// A plan kept to steps on a page whose step bar can't be read (stepKey '') does nothing there and
// reads nothing for its report (STEP_UNREAD_HALT, report.stepUnread).
// `takenBack` ({ steps, keys }: GEICO's Quote & Coverages): on those steps, a choice whose field
// key an earlier fill on this tab answered (keys) and that the page now shows otherwise was taken
// back by the page (GEICO puts its own coverage back when the agent backs out of a requote): kept
// and flagged, never given again, unless the agent asks to replace answers (`overwrite`).
// `hold` (the panel's "Check answers before Continue"): Continue is clicked only when `confirmed`
// is the page's `receipt()` as the agent approved it (Looks right) and still is; otherwise the
// report says `held`: 'check' (not approved yet) or 'changed' (the page changed since).
// A step with `waitFor` (a data-model name: GEICO's decoded year on a vehicle with a VIN) isn't
// answered while that question isn't drawn yet or is on the page without an answer: the page is
// still working it out, and its answer redraws the form (FL live run 2, 2026-10-21: the VIN decode
// cleared the vehicle type, distance and personal use the fill had just given; FL live run 3: GEICO
// draws the year only when its decode comes back, after them). It waits at most WAIT_MS, a round
// every WAIT_ROUND_MS, then is answered as before; a question waited out so is not waited for
// again. One that came in while the step waited is followed by AFTER_WAIT_QUIET_MS without a change
// on the page, then read again. A fill such a step was on the page for takes one more look at the
// end, once the page has gone quiet: an answer it gave that the page has cleared since is given
// again.
// A fill on a page with a step progress bar ends when the step on screen changes (stepKey): the
// rest of its plan is that step's, and the new step gets a fill of its own.
/**
 * One fill's run state: what its rounds, waits and helpers change and read again later. `fill`
 * creates it once (`state`, never reassigned) and sets each field where it was declared before;
 * the comments there say what each one is. Values derived once from the options, and the helper
 * functions, stay plain consts.
 * @typedef {object} RunState
 * @property {Set<string>} skipKeys the agent's edits that apply everywhere
 * @property {Set<string>} scopedKeys the agent's edits that apply where the kit is now
 * @property {Set<string>} clicked helper actions pressed
 * @property {Set<string>} openersTried
 * @property {Set<string>} nudged
 * @property {Map<string, number>} retries
 * @property {Set<string>} refill steps to answer again
 * @property {Set<string>} exhausted
 * @property {Map<string, any>} unoffered
 * @property {Map<string, any>} substituted
 * @property {Set<string>} keepWait
 * @property {Set<string>} keepSettled
 * @property {Map<string, any>} unitHeld
 * @property {Map<string, string>} heldFor a held step's id → the step it waits for
 * @property {Map<string, number>} waitingSince
 * @property {Set<string>} waitOver
 * @property {boolean} waitShown
 * @property {boolean} lastLook
 * @property {boolean} quietDue
 * @property {any} quietSig
 * @property {number} ajaxCount
 * @property {Set<string>} visited pages this run has been on
 * @property {Map<string, { status: string, note?: string | null }>} handled step id → its outcome
 * @property {FillReport} report what the fill returns
 * @property {string | null} topPage
 * @property {any} pendingAction the helper action pressed and not yet verified
 * @property {any} loadDue
 * @property {any} quiet
 * @property {boolean} progressed did the last round fill or click anything, or wait for what an answer draws?
 * @property {any[]} roundControls
 * @property {any} lastAnswered
 * @property {number} judgedTo
 * @property {number} provisionalLeft
 * @property {Set<string>} filledKeys
 * @property {boolean} resetWaited
 * @property {string} stoppedAt
 * @property {boolean} unreadStep
 * @property {boolean} agentPressed
 */
/**
 * One round of a fill: what its answering passes (`answerPasses`) and the steps after them change
 * and read. Each round creates its own (`thisRound`, never reassigned) and sets each field where
 * it was declared before; derived-once values and helpers of the round stay plain consts.
 * @typedef {object} RoundState
 * @property {number} lagBound
 * @property {any[]} invalidLeft
 * @property {number} judgedThrough
 * @property {boolean} changed did a pass answer anything?
 * @property {boolean} retry
 * @property {boolean} waited
 * @property {boolean} stepMoved
 * @property {number} stopAt
 * @property {number} pendingAt
 * @property {boolean} acted
 * @property {number} bound
 * @property {any[]} todo
 * @property {boolean} judgeOnly
 * @property {boolean} helperClicked
 */
/**
 * @param {any} plan
 * @param {FillOptions} [options]
 * @returns {Promise<FillReport>}
 */
export async function fill(plan, { overwrite = false, maxRounds = 60, skip = [], keepMarks = false, doneActions = [], replaceChoices = false, visitedPages = [], advance = null, batch = false, doneSteps = [], stopPages = [], stopSteps = [], units = null, skipBy = null, takenBack = null, hold = false, confirmed = null, run = null, loadResultMs = LOAD_RESULT_MS, budgetMs = FILL_BUDGET_MS, deadline = null, filledBefore = [], expectPage = null, formUnit = null, givenBefore = {}, pager = null, restarted = false } = {}) {
  /** @type {RunState} */
  const state = /** @type {any} */ ({});
  // The plan as given (helpers included, which the fill sets apart below), for a fill begun again.
  const givenPlan = plan;
  // The last helper's settled page, taken as this fill begins: one that returns early (another page,
  // a stop page or step) uses it up too, so a later fill can't take it for its own (review of #284).
  const left = settledAt;
  settledAt = null;
  // The agent's edits: `skipKeys` apply everywhere (`skip`, and those this fill protected itself),
  // `scopedKeys` are those of `skipBy` that apply where the kit is now, read again every round
  // (skipWhere).
  state.skipKeys = new Set(skip);
  state.scopedKeys = new Set();
  const skipped = (key) => state.skipKeys.has(key) || state.scopedKeys.has(key);
  // An agent edit protects its field. A plain name saved by an older build (field-key v2)
  // protects every row key made from it (name#<row>): it could have been any row's edit.
  const skippedKey = (key) => skipped(key) || skipped(globalThis.__raterFieldKey.rowKeyBase?.(key));
  // A field the agent edited, by its key, or by the question id an older build kept it under
  // (version 3) in a quote begun before this one: left alone rather than overwritten.
  const skippedField = (c) => skippedKey(fieldKey(c)) || skipped(globalThis.__raterFieldKey.legacyKey?.(c.el, { q: c.q }));
  // Such a question id can't be tied to its question for certain: saved before a renumbering,
  // it now belongs to another question, and the corrected one has a new number. While one is
  // kept, no answer already on a Duck Creek field is replaced, so whichever field the agent
  // corrected keeps their answer (Codex on PR #43).
  const legacyEdits = skip.some((k) => /^[0-9A-F]+(?:@\d+)?$/.test(String(k)));
  const mayHoldLegacyEdit = (c) => legacyEdits && c.q != null && hasValue(c);
  // The edits (`skipBy`) that apply where the kit is now: `scopedKeys`, set anew each round and for
  // the final reads, so a form drawn partway through the fill has its own, never the previous
  // form's. GEICO asks one data-model name on several steps and forms (the owner's GiveLastName
  // and each driver's; a vehicle's GiveYear and a trailer's), so an edit protects its field only
  // on its own step, unit or form. On a unit step: the active unit's edits on a form that isn't
  // held, and every form's own; a held form gets only its own, so its check is gone only once the
  // agent dismissed or answered that form's. No form on screen (GEICO's owner check under Vehicles
  // asks Business & Owner Info's questions again, and little else): every step's edits, never a
  // unit's (the owner's own driver form asks Add Driver's license state, CDL and SR-22).
  const skipNames = skipBy ? [...Object.keys(skipBy.stepUnits ?? {}), ...Object.keys(skipBy.steps ?? {})] : [];
  const skipWhere = (units) => {
    state.scopedKeys.clear();
    const key = stepKey();
    const name = skipNames.find((n) => stepIs([n], key));
    if (!name) return;
    const add = (keys) => { for (const k of [].concat(keys ?? [])) state.scopedKeys.add(k); };
    const list = Object.hasOwn(skipBy.stepUnits ?? {}, name) ? skipBy.stepUnits[name] : null;
    if (!list) return add(skipBy.steps?.[name]);
    if (!units?.length) {
      for (const keys of Object.values(skipBy.steps ?? {})) add(keys);
      return;
    }
    for (const u of units) {
      if (!u.held) add(skipBy.units?.[u.list]);
      add(skipBy.forms?.[u.id]);
    }
  };
  /** @type {any[]} */ const actions = plan.filter((s) => s.kind === 'action');
  // Helpers are clicked in the top frame, and those marked `inFrame` in any frame that shows them.
  const helpersHere = window === window.top || actions.some((a) => a.inFrame);
  /** @type {any[]} */ plan = plan.filter((s) => s.kind !== 'action');
  state.clicked = new Set(doneActions);
  state.openersTried = new Set();
  state.nudged = new Set();
  // Answers the page changed or cleared after we gave them (a lookup redrawing its boxes, a
  // panel re-rendering), or didn't keep the first time: given again, at most twice each.
  state.retries = new Map();
  state.refill = new Set();
  // Helpers whose result never showed after their tries this fill: the agent's, not clicked again.
  state.exhausted = new Set();
  // A lookup box its helper has already used (the VIN list Import Data empties) isn't given again.
  const immediateAfter = new Set(actions.filter((a) => a.immediate).flatMap((a) => a.after));
  setHiddenOk(plan.filter((s) => s.hidden && s.selector).map((s) => s.selector));
  const consumedPaths = () => new Set(actions.filter((a) => state.clicked.has(a.action)).flatMap((a) => a.after));
  // Choices whose option isn't offered yet (`whenOffered`), by step id.
  state.unoffered = new Map();
  // Options picked in place of one never offered (`orMost`), by step id: what the report says.
  state.substituted = new Map();
  const retryOnce = (id) => { const n = state.retries.get(id) ?? 0; if (n >= 2) return false; state.retries.set(id, n + 1); return true; };
  // Answers the page didn't keep: each is given again only once the page, and its own requests,
  // have been quiet for RESET_QUIET_MS (GEICO live run, 2026-10-28: on a slow page the Sprinter's
  // comprehensive was reset while GEICO still answered the collision before it, and the tries at
  // once were reset too), by step id until given or left; `keepSettled`, those waited for since.
  // One still to give holds `whenClear` helpers (leftForAgent).
  state.keepWait = new Set();
  state.keepSettled = new Set();
  // `needs` (a choice the page offers only once another on its unit holds: GEICO's collision,
  // rental and road service behind comprehensive): a prerequisite the page didn't keep, by step id,
  // with its unit's one item (`unitHeld`), and the steps held behind one (`heldFor`, by step id).
  state.unitHeld = new Map();
  state.heldFor = new Map();
  // Steps waiting for the page (`waitFor`): since when, by step id.
  state.waitingSince = new Map();
  const mayWait = (id) => {
    if (!state.waitingSince.has(id)) state.waitingSince.set(id, Date.now());
    return Date.now() - state.waitingSince.get(id) < WAIT_MS;
  };
  // Steps done waiting this fill (what they waited for came in, or the wait ran out).
  state.waitOver = new Set();
  // A step that waits on the page (`waitFor`) was on it this fill, and the last look (see `waitFor`
  // above) once taken.
  state.waitShown = false;
  state.lastLook = false;
  // Where Continue waits for a quiet page (`advance.quietMs`: GEICO), a fill that gave answers waits
  // for it before it ends and answers what the page drew meanwhile (the end of a round): `quietDue`,
  // an answer was given since the last such wait; `quietSig`, the questions on screen once the page
  // was quiet then.
  state.quietDue = false;
  state.quietSig = null;
  // Server requests the page sends (as its adapter sees them), counted for the per-answer timing.
  state.ajaxCount = 0;
  const countAjax = () => { state.ajaxCount++; };
  adapter().onRequest(countAjax);
  state.visited = new Set(visitedPages);
  const startPage = currentPage();
  // The plan has questions for this page (a field rule for it, not only helpers): while it shows no
  // field it is still drawing, and its helpers wait for one (W44-03), except a tile pick
  // (`onBlankPage`: Most Common Vehicles, which may draw only its tiles).
  const expectsQuestions = plan.some((s) => s.kind !== 'action' && s.pages?.includes(startPage));
  state.handled = new Map(); // step id -> { status, note }
  /** @type {FillReport} */
  state.report = { frame: location.origin + location.pathname, fields: 0, filled: [], noData: [], kept: [], failed: [], leftRequired: [], actions: [], unknown: [], blocked: [], protectedKeys: [], invalidatedActions: [], checks: [], reworded: [], renamed: [], halted: false, rounds: 0, unitForm: null, unitHeld: null, stepUnread: false };
  // The page the panel asked to fill (`expectPage`, as it reads the tab's address): the top frame
  // shows another one now (the agent or the carrier moved on while the panel prepared), so nothing
  // is filled, marked or clicked here (`pageMoved`, the page found). A frame inside the page reads
  // the top's address when it may (the same origin); one that can't (another origin's: a chat
  // window) goes on, as the panel checked just before.
  state.topPage = null;
  try { state.topPage = window === window.top ? startPage : pageAt(window.top.location); } catch { /* another origin */ }
  if (expectPage != null && state.topPage != null && state.topPage !== expectPage) {
    adapter().offRequest(countAjax);
    state.report.pageMoved = state.topPage;
    return state.report;
  }
  setComponentPrefix(adapter().components);
  // Every frame that answers watches its own requests (an answer's wait counts from the last one's end).
  watchRequests();
  if (!keepMarks) clear();
  stopSteps = [].concat(stopSteps ?? []);
  if (stopSteps.length) addStopSteps(stopSteps);
  // Its unit forms' markers, by which unitFormsNow tells the forms on screen between fills.
  const markers = [...new Map(plan.filter((s) => s.whenShown?.unit).map((s) => [JSON.stringify(s.whenShown), s.whenShown])).values()];
  if (markers.length) setKnownUnitMarkers(markers);
  if (stopPages.includes(startPage)) {
    state.report.halted = true;
    state.report.reason = 'The carrier stopped this quote on this page: nothing is filled or clicked here.';
    state.report.stepKey = stepKey();
    return state.report;
  }
  // A step that is the agent's, as the fill starts (also at every round, below).
  const stopAt = stopStepOn(stopSteps);
  if (stopAt) {
    state.report.halted = true;
    state.report.reason = STOP_STEP_HALT;
    state.report.stopStep = stopAt;
    state.report.stepKey = stepKey();
    return state.report;
  }
  const serverBacked = adapter().serverBacked();
  state.pendingAction = null;
  // A helper that loads a view, due but not clicked until the page has been quiet (`loadDue`), and
  // the page it was quiet on (`quiet`: its action and signature).
  state.loadDue = null;
  state.quiet = null;
  state.progressed = false; // did the last round fill or click anything, or wait for what an answer draws?
  // The questions the last round read (in document order): where the items are on the page
  // when a helper has opened the next page by the end of the fill.
  state.roundControls = [];
  // Judged at the cursor, top to bottom (docs/browser-filling.md, "Judged at the cursor"): the page
  // is answered top to bottom, and what is above decides what appears below (GEICO live run,
  // 2026-10-28: a CSL liability limit took Property Damage and UMPD off the page after a round had
  // made them needs-you items). Each round judges only the questions above its cursor, the first
  // one the fill still has to act on; those below it are provisional, with no item, mark or
  // blocker, until the cursor reaches them. `lastAnswered`: the question the last round answered
  // (where the page isn't ExtJS and fills one answer at a time: GEICO), whose redraw may land after
  // the page went quiet, so the next round judges nothing below it until it acts further down
  // (`lagBound`). `judgedTo`: how far down the last round judged (Infinity: all of it), and
  // `provisionalLeft`, how many questions it left below that, which hold `whenClear` helpers.
  state.lastAnswered = null;
  state.judgedTo = Infinity;
  state.provisionalLeft = 0;
  const halt = (reason) => { state.report.halted = true; state.report.reason = reason; };
  // A wait that ended unsettled: the fill halts for it, unless it ended because the fill had stopped
  // already (Stop, or the agent's edit), whose reason stays.
  const stalled = (reason) => { if (!state.report.halted) halt(reason); };
  // Answers this fill gave that their field no longer shows (a later server response rewrote or
  // cleared them), each with its question as `pairs` read it. A field the agent edited, and a
  // lookup box its helper has used, don't count.
  // Field keys this tab's fills answered before (`filledBefore`), and whether this fill has waited
  // for a quiet page before giving one the page reset again.
  state.filledKeys = new Set(filledBefore);
  state.resetWaited = false;
  const changedSinceFilled = (pairs) => {
    const consumed = consumedPaths();
    return state.report.filled.flatMap((previous) => {
      const pair = pairs.find(({ step }) => step.id === previous.stepId);
      return !pair || skippedField(pair.control) || agreesWith(pair.step, pair.control) || consumed.has(pair.step.path) ? [] : [{ previous, pair }];
    });
  };
  // `needs`: one unit's steps are those naming the same unit (a per-vehicle row's year, make and
  // model; a page with one vehicle has no hint, and every step there is its).
  const sameUnit = (a, b) => (a.scope ?? null) === (b.scope ?? null) && (a.vehicleHint ?? []).join(' ') === (b.vehicleHint ?? []).join(' ');
  const needsOf = (step) => (step.needs?.length ? plan.filter((s) => s.id !== step.id && s.q != null && step.needs.includes(s.q) && sameUnit(s, step)) : []);
  // The answers on a step's unit still to give that need it: on the page, not the agent's, not
  // given or left yet, and not already showing their answer.
  const dependentsOf = (step, pairsNow) => (step.q == null ? [] : pairsNow.filter(({ step: s, control }) => s.id !== step.id && s.needs?.includes(step.q) && sameUnit(s, step)
    && s.value != null && !s.note && !s.ignore && !state.handled.has(s.id) && !skippedField(control) && !agreesWith(s, control)));
  // A coverage's name without the rule's own words in brackets ("Rental reimbursement (TNI: …)").
  const coverageName = (s) => { const n = String(s.name ?? '').replace(/\s*\(.*\)\s*$/, '').trim(); return n.charAt(0).toLowerCase() + n.slice(1); };
  const wordList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const unitHeldNote = ({ step, deps, tries, code, reason }) => {
    const pre = coverageName(step);
    const why = code === 'answer.not-kept' ? `didn't stick on the page (tried ${tries} time${tries === 1 ? '' : 's'}, each once the page was quiet)` : `couldn't be set (${reason})`;
    return `${pre.charAt(0).toUpperCase()}${pre.slice(1)} ${why}. This vehicle's ${wordList([...new Set(deps.map(coverageName))])} depend${deps.length === 1 ? 's' : ''} on it, so the fill left ${deps.length === 1 ? 'it' : 'them'} too. Set its ${pre} yourself, then fill again.`;
  };
  const holdDependent = (s, root) => {
    state.heldFor.set(s.id, root.step.id);
    if (!root.deps.some((d) => d.id === s.id)) {
      root.deps.push(s);
      root.item.note = unitHeldNote(root);
      state.handled.set(root.step.id, { status: 'needs', note: root.item.note });
    }
    state.handled.set(s.id, { status: 'needs', note: `Waits for ${coverageName(root.step)} on this vehicle, which the page didn't keep: see that item.` });
  };
  // A prerequisite that didn't take, with answers on its unit that need it still to give: one
  // needs-you item for the unit (which holds `whenClear` helpers: Recalculate and after), and its
  // dependents held behind it, none a failure of its own. False when nothing waits on it.
  const holdUnit = (step, c, item, reason, code, pairsNow) => {
    const deps = dependentsOf(step, pairsNow).map((p) => p.step);
    if (!deps.length) return false;
    const root = { item: { ...item, ...describe(c) }, step, deps: [], tries: (state.retries.get(step.id) ?? 0) + 1, code, reason };
    state.unitHeld.set(step.id, root);
    for (const d of deps) holdDependent(d, root);
    root.item.note = unitHeldNote(root);
    state.report.noData.push(root.item);
    state.handled.set(step.id, { status: 'needs', note: root.item.note });
    return true;
  };
  // `phase`: what the fill is doing between answers, for the panel's live list and dock (progress):
  // null while it answers, else { name, what }: 'reading' the page as it begins, 'waiting' for the
  // page after an answer, a 'helper' it clicked (`what`: the button), the 'premium' it rates, or
  // 'continue'. Said so a fill waiting on GEICO's Recalculate doesn't read as stuck (2026-10-23).
  // Set below with the fill's deadline: whether its time is spent, halting it if so.
  const thisFill = { report: state.report, halt, run, phase: null, timeUp: () => false };
  const phase = (name, what = null) => { thisFill.phase = name ? { name, what } : null; };
  running = thisFill;
  // Its time in all (`budgetMs`): once it is spent, the fill stops as on Stop, its waits with it, and
  // the report says why (`outOfTime`). A fill begun again in its frame (below) keeps this one's end
  // (`deadline`), not a new budget.
  const ends = deadline ?? Date.now() + budgetMs;
  const outOfTime = () => {
    if (state.report.halted) return;
    halt(budgetMs === FILL_BUDGET_MS ? BUDGET_HALT : BUDGET_HALT.replace('5 minutes', `${Math.round(budgetMs / 1000)} s`));
    state.report.outOfTime = true;
  };
  thisFill.timeUp = () => { if (Date.now() >= ends) outOfTime(); return state.report.halted; };
  const budget = setTimeout(outOfTime, Math.max(0, ends - Date.now()));
  // Stopped by the agent before it began (the panel was still preparing): nothing is done.
  if (run != null && stoppedRuns.delete(run)) halt(STOP_HALT);
  // A real user edit during a fill must survive even while the recorder is paused: its field is
  // protected (also from this fill's later rounds) and the fill stops. The guard is on from before
  // the fill's first wait for the page, as the recorder is paused already then: an edit in that
  // wait (seconds, on a page waiting on its server) was neither the recorder's nor the guard's, and
  // the fill put its own choice over it (LEARN-07, 2026-11-07). It stays on until the fill returns,
  // so an edit during the wait before Continue stops that too.
  const releaseEditGuard = guardEdits((key) => {
    state.skipKeys.add(key);
    if (!state.report.protectedKeys.includes(key)) state.report.protectedKeys.push(key);
    halt(EDIT_HALT);
  });
  phase('reading');
  const fresh = !!left && serverBacked && Date.now() - left.at < SETTLED_FRESH_MS && !pageBusy() && currentPage() === left.page && signature() === left.sig;
  let settled;
  try { settled = await settle({ quietMs: fresh ? START_SETTLED_QUIET_MS : 400, maxMs: 15000, why: 'start' }); } catch (e) { releaseEditGuard(); clearTimeout(budget); throw e; }
  phase(null);
  // Stopped while the page settled: nothing was done.
  if (!settled || state.report.halted) {
    releaseEditGuard();
    if (!settled) stalled('The page is still waiting on its server. Review and retry.');
    state.report.stepKey = stepKey();
    clearTimeout(budget);
    if (running === thisFill) running = null;
    return state.report;
  }
  // A frame that turned into the top's page while the fill waited to begin: Arizona's business
  // type popup draws in a frame of its own, which showed Business Owner Info as the fill began there
  // and the popup a moment later (AZ live recording, 2026-11-05: that frame's fill found its page
  // gone and did nothing, and no fill came after it). The fill begins again on the page it shows
  // now, once.
  if (!restarted && window !== window.top && currentPage() !== startPage && currentPage() === topPageNow()) {
    adapter().offRequest(countAjax);
    releaseEditGuard();
    clearTimeout(budget);
    if (running === thisFill) running = null;
    return fill(givenPlan, { ...arguments[1], restarted: true, deadline: ends });
  }
  // The step on screen as the fill begins, on a page with a step progress bar (null elsewhere:
  // AmWINS' headings change with its dialogs). Read once the page has settled.
  const startStep = stepBars().length ? stepKey() : null;
  const stepChanged = () => startStep !== null && stepKey() !== startStep;
  // A stop step the fill found on screen after it started: it does nothing more, and reads nothing
  // there for its report.
  state.stoppedAt = '';
  // A plan kept to steps on a page whose step bar can't be read (STEP_UNREAD_HALT): the same.
  const steppedPlan = plan.some((s) => s.steps?.length);
  state.unreadStep = false;
  // A button the agent clicks during the fill (Next, "+", Looks Good) moves the page on their
  // click: this fill clicks no Continue and no helper after it (FL live run 4, 2026-10-21: the
  // agent's Next, then a fill's, while GEICO still worked on the first).
  state.agentPressed = false;
  const notePress = (event) => {
    if (!event.isTrusted) return;
    const path = event.composedPath?.() ?? [event.target];
    if (path.some((n) => n?.nodeType === 1 && safeMatches(n, agentPress()) && !n.hasAttribute('aria-expanded'))) state.agentPressed = true;
  };
  document.addEventListener('click', notePress, true);
  // Whether the registered names a USDOT lookup offers (Progressive's Business Name choice) are
  // on the page and none, or several, is the intake's: the identity is then the agent's.
  const IDENTITY_NOTE = 'The DOT lookup business name differs from the intake. Verify the identity before accepting it.';
  const identityDiffers = (step, controls) => {
    if (!step.businessNames?.length) return false;
    const registered = assign(controls, plan).find((p) => p.step.registeredName)?.control;
    const names = uniqueBusinessNames(registered ? optionsOf(registered).filter((o) => o.text.trim() && !/^enter a different/i.test(o.text)) : []);
    const matches = names.filter((o) => step.businessNames.some((name) => businessNameKey(o.text) === businessNameKey(name)));
    return names.length > 0 && matches.length !== 1;
  };
  // A registered name shown only after this fill answered (Progressive shows it right after
  // "belongs to the business" Yes): that answer is the agent's to verify too, as if the name had
  // been there first. It stays on the page, and Continue waits. A field the agent edited since is
  // theirs already. Returns the items it moved, each with its field.
  const identityAfterAnswer = (pairs, controls) => {
    const moved = [];
    for (const { step, control } of pairs) {
      const previous = state.report.filled.find((x) => x.stepId === step.id);
      if (!previous || step.registeredName || skippedField(control) || !identityDiffers(step, controls)) continue;
      state.report.filled = state.report.filled.filter((x) => x !== previous);
      state.report.checks = state.report.checks.filter((x) => x.stepId !== step.id);
      const item = { ...previous, note: IDENTITY_NOTE, reviewOnly: true, ...describe(control) };
      state.report.noData.push(item);
      state.handled.set(step.id, { status: 'needs', note: IDENTITY_NOTE });
      moved.push({ item, control });
    }
    return moved;
  };
  try {
  // This fill's units (see unitFormsOf); a form it answers a unit on is that unit's for the rest
  // of the fill too.
  setFillUnits({
    active: { ...units?.active }, count: { ...units?.count },
    bound: Object.fromEntries(Object.entries(units?.bound ?? {}).map(([list, forms]) => [list, { ...forms }])),
  });
  // The lists whose forms the plan gives an answer: only such a form is bound to the active unit.
  // GEICO's Add Driver while the panel's driver is the owner (whom GEICO already lists) is all
  // notes: bound to the owner, it would be held as the owner's once the agent picks its driver.
  const answeredLists = new Set(plan.filter((s) => s.whenShown?.unit && s.value != null && s.value !== '').map((s) => s.whenShown.unit));
  // A page that draws its units' rows a few at a time behind group buttons (`pager`, makePager).
  const unitGroups = makePager(plan, pager, startPage);
  // The rules of coverage sections the page closes (offPage), and the failed choices given once more
  // against options the page redrew (retryRedrawn), by step id.
  const closable = new Set(plan.filter((s) => Object.values(CLOSED_SECTIONS).some(({ tag }) => s[tag] === 'section')).map((s) => s.id));
  const redrawRetried = new Set();

  for (let round = 0; round < maxRounds; round++) {
    /** @type {RoundState} */
    const thisRound = /** @type {any} */ ({});
    state.report.rounds = round + 1;
    phase(null);
    // The agent's Next changes the step without a new address: on a step that is the agent's the
    // fill does nothing more, and another step is left to a fill of its own.
    state.stoppedAt = stopStepOn(stopSteps);
    if (state.stoppedAt) { state.report.stopStep = state.stoppedAt; if (!state.report.halted) halt(STOP_STEP_HALT); break; }
    if (stepChanged()) break;
    // The page moved on under the fill (the agent's Continue: Progressive draws the next page at
    // the same document): this fill's page is gone, and the next page gets a fill of its own. The
    // fill had read Rates as its next round and clicked Print, Email, Fax as the agent did (live
    // recording, 2026-10-23).
    if (currentPage() !== startPage) { state.report.navigatedTo = currentPage(); break; }
    // The step can't be read, and the fill began there (a step it began on that turns unreadable
    // is the agent's Next mid-redraw: the step changed, above). Nothing is done or read here.
    if (steppedPlan && stepBars().length && stepKey() === '') {
      state.unreadStep = true;
      // Only this halt: the panel tries an automatic fill once more rather than pausing them all.
      if (!state.report.halted) { halt(STEP_UNREAD_HALT); state.report.stepUnread = true; }
      break;
    }
    // A form that names its unit for another one than the plan's: nothing is filled (W43-37).
    if (formUnit) {
      const named = unitNamedNow();
      if (named) state.report.unitNamed = { list: formUnit.list, index: named.index };
      if (named && named.index !== formUnit.active) {
        halt(`This form is for ${named.name || 'someone else'}, not ${formUnit.label}: nothing was filled. ${named.index == null
          ? 'The intake has no driver by that name: fill the form yourself.' : `Pick ${named.name} in the panel, then fill again.`}`);
        state.report.unitMismatch = true;
        break;
      }
    }
    const controls = collectControls();
    state.roundControls = controls;
    state.report.fields = Math.max(state.report.fields, controls.length);
    if (thisFill.timeUp()) break;
    const allPairs = assign(controls, plan);
    // The agent's edits made where the kit is now, before anything asks whether a field is theirs.
    if (skipBy) skipWhere(allPairs.units);
    unitGroups.noteRound(controls, allPairs, skippedField);
    // Each question's place on the page (its place among the controls read, which are read in page
    // order through shadow roots): what the round's cursor and its judgments go by.
    const place = new Map(controls.map((c, i) => [c, i]));
    // The question the last round answered, here (`lastAnswered`): nothing below it is judged this
    // round until the fill acts further down (`lagBound`, past it), since GEICO draws what an answer
    // changes below it after the page went quiet (2026-10-28: Property Damage and UMPD taken off a
    // moment after the CSL limit). Not on ExtJS pages, whose wait covers the server's response, nor
    // for a batch, whose cursor is the end of what it fills.
    thisRound.lagBound = Infinity;
    if (state.lastAnswered) {
      const answeredNow = allPairs.find((p) => p.step.id === state.lastAnswered.stepId)?.control;
      thisRound.lagBound = (answeredNow ? place.get(answeredNow) : state.lastAnswered.at) + 1;
      state.lastAnswered = null;
    }
    // Review items are flagged in yellow and the rest of the page still fills. Only a stuck
    // page or an agent edit stops the fill.
    const mapped = new Set(allPairs.map((p) => p.control));
    // Rows of one repeated question share a key; their labels (the vehicle) tell them apart.
    const flag = (list, item) => { if (!list.some((x) => x.key === item.key && x.label === item.label)) list.push(item); };
    // The unit forms on screen (assign): one the plan answers for the active unit is that unit's,
    // for the panel (report.unitForm) and for the rest of this fill; one that may be another unit's
    // is held, as one check for the agent (judgeControls), named by its place in the intake's list.
    // Marked done in the panel (its first question is then the agent's), the form stays held,
    // without the check; with `skipBy` only an edit filed under that form counts, never one of the
    // active unit's.
    for (const u of allPairs.units) {
      if (u.held) state.report.unitHeld = { list: u.list, id: u.id };
      else if (answeredLists.has(u.list)) {
        state.report.unitForm = { list: u.list, id: u.id };
        const fu = getFillUnits(); if (fu) (fu.bound[u.list] ??= {})[u.id] = u.active;
      }
    }
    const renamed = new Map(allPairs.renamed.map((r) => [r.control, r.step]));
    const unmatched = new Map(allPairs.unmatchedRows.map((r) => [r.control, r.step]));
    // An answer the page invalidated after another one changed (Progressive's liability limit after
    // a PIP change) is picked again, at most twice; then it's the agent's (judgeControls). Never one
    // the identity check left to the agent, nor a `keepChoice` answer this fill didn't give (a
    // person's): those stay as they are, flagged.
    thisRound.invalidLeft = [];
    for (const c of controls) {
      if (!mapped.has(c) || skippedField(c) || !hasValue(c) || !invalidControl(c)) continue;
      const own = allPairs.find((p) => p.control === c)?.step;
      const ours = !!own && state.handled.get(own.id)?.note !== IDENTITY_NOTE
        && (!(own.keepChoice || own.keepPreset) || state.refill.has(own.id) || state.report.filled.some((x) => x.stepId === own.id));
      if (ours && own.value != null && !own.ignore && !own.note && !own.verifyOnly && retryOnce(own.id)) {
        state.report.failed = state.report.failed.filter((x) => x.key !== fieldKey(c));
        state.handled.delete(own.id);
        state.refill.add(own.id);
        continue;
      }
      thisRound.invalidLeft.push(c);
    }
    // A text box the page already has a different value in (e.g. from the USDOT lookup): kept and
    // shown, not replaced. Not what a fill gave for another unit (W43-38): that is replaced below.
    const keptDiffers = (step, control) => !skippedField(control) && hasValue(control) && !step.verifyOnly && !step.ignore && !step.note && !step.replace && !step.trustPage && step.value != null
      && control.kind === 'text' && !overwrite && !agreesWith(step, control) && !state.handled.has(step.id) && !state.refill.has(step.id) && !givenForOtherUnit(step, control);
    const keepDiffering = (step, control) => {
      flag(state.report.kept, { label: control.label, key: fieldKey(control), q: control.q, path: step.path, name: step.name, differs: true });
      mark(control, 'needs', `page says something different from the intake (${step.name})`);
      state.handled.set(step.id, { status: 'needs', note: `page value differs from the intake: ${step.name}` });
    };
    // A batch is judged whole, as before the loop (its cursor is the end of what it fills); one
    // answer at a time, each such box when the loop reaches it, at its place.
    if (batch) for (const { step, control } of allPairs) if (keptDiffers(step, control)) keepDiffering(step, control);
    // What the round judges of the page's questions themselves, above `upTo` (a place: the round's
    // cursor), each once a round: a held unit form's check, wording changes, rows no unit matched,
    // unfamiliar questions, answers the page marks invalid, and looked-up values that differ.
    // Below it nothing is said or marked yet (`provisionalLeft`).
    thisRound.judgedThrough = 0;
    const judgeControls = (upTo) => {
      const from = thisRound.judgedThrough;
      const to = Math.min(upTo, controls.length);
      if (to <= from) return;
      thisRound.judgedThrough = to;
      // Not one the page has taken away since the round read it (an answer's redraw).
      const here = (c) => { const at = place.get(c); return at !== undefined && at >= from && at < to && c.el?.isConnected !== false; };
      for (const u of allPairs.units) {
        if (u.held && here(u.marker) && !skippedField(u.marker)) flag(state.report.checks, { label: u.marker.label, path: null, name: `${unitNoun(u.list)} ${Number(u.active) + 1}`, key: fieldKey(u.marker), q: null, controlKind: null, note: heldFormNote(u) });
      }
      // Known questions whose wording changed (answered, and flagged when answered), and fields that
      // read like a known question whose data-model name isn't on the page (left for the agent).
      for (const p of allPairs.filter((x) => x.reworded && here(x.control))) flag(state.report.reworded, { label: p.control.label, key: fieldKey(p.control), name: p.step.name, field: p.step.field });
      for (const [c, step] of renamed) if (here(c)) flag(state.report.renamed, { label: c.label, key: fieldKey(c), name: step.name, field: step.field, now: c.ref ?? null });
      // A per-unit question's row naming a unit no step's unit matched (none of the intake's
      // vehicles or trailers, or two alike): a known question left to the agent, named by its row.
      for (const [c, step] of unmatched) {
        if (!here(c) || skippedField(c)) continue;
        const note = unmatchedRowNote(step);
        flag(state.report.checks, { label: c.label, path: null, name: step.name, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, note, ...describe(c) });
        mark(c, 'needs', note);
      }
      for (const c of controls) {
        // A row a witness step chooses among is a known question (its unit is named instead), and
        // so is a held unit form's (the form is named instead), and a unit's row no unit matched.
        if (!here(c) || mapped.has(c) || skippedField(c) || allPairs.witnessed.has(c) || allPairs.held.has(c) || unmatched.has(c)) continue;
        flag(state.report.unknown, { label: c.label, key: fieldKey(c), q: c.q, ref: c.ref ?? null, controlKind: c.kind, required: c.required, ...describe(c) });
        mark(c, 'needs', renamed.has(c) ? `Looks like "${renamed.get(c).name}", but the carrier renamed this field: left for you.` : 'Unfamiliar question — left for you.');
      }
      // Said once for its field, also when this round's answer to it failed too (its own item).
      for (const c of thisRound.invalidLeft) {
        if (!here(c)) continue;
        const reason = 'The page marks this answer invalid.';
        const key = fieldKey(c);
        if (!state.report.failed.some((x) => x.key === key && x.label === c.label && (x.reason === reason || !x.stepId))) state.report.failed.push({ label: c.label, key, q: c.q, controlKind: c.kind, code: 'answer.invalid', reason, ...describe(c) });
        mark(c, 'failed', 'the page marks this answer invalid');
      }
      for (const { step, control } of allPairs) {
        if (!here(control) || skippedField(control) || !hasValue(control)) continue;
        if (step.verifyOnly && !agreesWith(step, control)) {
          flag(state.report.failed, { label: control.label, key: fieldKey(control), q: control.q, code: 'lookup.differs', reason: 'The looked-up value differs from the intake. Check the VIN.' });
          mark(control, 'failed', 'lookup result differs from the intake');
        }
      }
    };
    for (const { previous, pair } of changedSinceFilled(allPairs)) {
      if (retryOnce(pair.step.id)) {
        state.report.filled = state.report.filled.filter((x) => x !== previous);
        state.handled.delete(pair.step.id);
        state.refill.add(pair.step.id);
        continue;
      }
      if (hasValue(pair.control)) {
        state.report.failed.push({ ...previous, code: 'answer.changed', reason: 'A later server response changed this answer; check it.' });
        state.report.filled = state.report.filled.filter((x) => x !== previous);
        state.handled.set(pair.step.id, { status: 'failed', note: 'a later server response changed this answer' });
      }
    }
    identityAfterAnswer(allPairs, controls);
    // The round's judgments made, above `upTo`, and what it streams to the panel (progress): one
    // snapshot of the items in page order a round.
    // `atCursor`: the question at `upTo` is the cursor's own, still to give (it holds `whenClear`
    // helpers as one not judged yet), and said failed at the end of the fill if never given: only
    // those below it are left unjudged by the fill's end (`judgedTo`).
    const judged = (upTo, atCursor = false) => {
      judgeControls(upTo);
      state.provisionalLeft = upTo >= controls.length ? 0 : controls.length - upTo;
      state.judgedTo = state.provisionalLeft - (atCursor ? 1 : 0) > 0 ? upTo : Infinity;
      streamItems(controls);
    };
    if (state.report.halted) { judged(Math.min(thisRound.lagBound, firstOpen(allPairs, place))); break; }
    // Buttons that must come right after their field (Verify DOT, Lookup VIN) go first: the page
    // is judged down to the first question still to act on (the helper's own field is above it).
    if (helpersHere && clickNextAction(controls, true)) {
      judged(Math.min(thisRound.lagBound, firstOpen(allPairs, place)));
      // A lookup (Import Data) may wait on its server without changing the page for a while.
      phase('helper', state.pendingAction?.label ?? state.report.actions.at(-1)?.text ?? null);
      if (!await settle(serverBacked ? { why: 'helper' } : { quietMs: 800, maxMs: 8000, why: 'helper' })) { stalled('The helper response did not settle. Review before retrying.'); break; }
      if (!await verifyAction()) break;
      if (currentPage() !== startPage) { state.report.navigatedTo = currentPage(); break; }
      if (stepChanged()) break;
      continue;
    }
    const pairs = assign(controls, plan).filter(({ step, control }) => !state.handled.has(step.id) && !skippedField(control));
    // Answers given one at a time go down the page, as the agent works it: what an answer draws
    // under its question comes before the questions further down. In rule order a fill went up and
    // down the page (GEICO mock, Business & Owner Info: the business name, 14th of 16, first, then
    // the owner's name at the top). A batch round keeps the rules' order: its answers land
    // together, and AmWINS' driver names and license number come before gender, marital status
    // and the license year, which sit between them on the page.
    if (!batch) pairs.sort((a, b) => place.get(a.control) - place.get(b.control));
    thisRound.changed = false;
    // A failed answer may still have redrawn the page (new questions): look again next round.
    thisRound.retry = false;
    // A step waited for the page this round (`waitFor`).
    thisRound.waited = false;
    // Another step on screen since the round began (the agent clicked Next): this round's
    // questions are that step's no longer, and nothing more is given or clicked for them.
    thisRound.stepMoved = false;
    // The round's cursor (`stopAt`): the first question, in page order, the fill still has to act on
    // (an answer to give, or one waiting for the page), where one answer at a time stops. Judged
    // only above it; `acted`, the round gave or tried an answer, or waits on one. A pair at or below
    // `bound` (the last answer's lag) is provisional: whatever it would be judged (needs you, kept,
    // a check) waits, untouched, and a choice that finds no option there is tried again in a later
    // round (the page may still redraw its options). The second pass judges what waited, from the
    // same read, once the page has settled after this round's own answer (the waits for the last
    // one's redraw), each only while its field is still in the page (an answer above took it away
    // otherwise), or when the round had nothing to act on. It gives and waits for nothing
    // (`judgeOnly`): an answer it finds still to give is the next round's.
    thisRound.stopAt = Infinity;
    // The first question still to give or wait for (the cursor's own; stopAt also ends where a
    // failure made the round read the page again).
    thisRound.pendingAt = Infinity;
    thisRound.acted = false;
    thisRound.bound = batch ? Infinity : thisRound.lagBound;
    thisRound.todo = pairs;
    thisRound.judgeOnly = false;
    await answerPasses();

    // The round's answers, in up to two passes: each pair on the page in order, answered, kept,
    // held or left; what they did is in thisRound (changed, retry, waited, stepMoved, acted, …).
    async function answerPasses() {
      for (let pass = 0; pass < 2; pass++) {
      const later = [];
      for (const pair of thisRound.todo) {
        const { step: planned, control: c, how, reworded } = pair;
        if (stepChanged() || stopStepOn(stopSteps)) { thisRound.stepMoved = true; break; }
        const at = place.get(c);
        const provisional = at >= thisRound.bound;
        // Not judged this pass: kept for the second.
        const notYet = () => { if (!provisional) return false; later.push(pair); return true; };
        // The cursor: an answer the fill still has to give here (or wait for).
        const cursor = () => { thisRound.acted = true; thisRound.stopAt = Math.min(thisRound.stopAt, at); thisRound.pendingAt = Math.min(thisRound.pendingAt, at); };
        if (!batch && keptDiffers(planned, c)) {
          if (notYet()) continue;
          keepDiffering(planned, c);
          continue;
        }
        // A known field whose question reads differently now: answered, and the agent checks it.
        const step = reworded ? { ...planned, warn: [planned.warn, `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check the answer.`].filter(Boolean).join(' ') } : planned;
        const item = /** @type {any} */ ({ stepId: step.id, label: c.label, path: step.path, name: step.name, key: fieldKey(c), q: c.q ?? null, controlKind: c.kind, how, standard: !!step.standard, manualOnly: !!step.manualOnly,
          // Where its answer comes from (plan.js `source`) and whether review mode asks the agent to
          // confirm it, for the usage log (a TNI standard or an intake fact; a check item or not).
          source: step.source ?? null, review: !!step.reviewRequired,
          // Its answer read a value the agent corrected in the panel (plan.js `edited`).
          ...(step.edited ? { edited: true } : {}),
          // A field another step of a one-address application holds (AmWINS keeps every step's
          // section in the page, hidden): filled again here, but not this step's question.
          ...(step.hidden && otherStep(c.el) ? { otherStep: true } : {}) });
        // A question left as the page has it whose wording changed: what the page has may not fit
        // any more, so the agent checks it (Continue waits).
        const leftAlone = step.verifyOnly || step.ignore;
        if (leftAlone && reworded) {
          if (notYet()) continue;
          const note = `The carrier's wording of this question changed (it read "${[].concat(planned.ask ?? [])[0] ?? planned.re}"): check what the page has.`;
          if (step.verifyOnly) state.report.kept.push(item);
          state.report.checks.push({ ...item, note, ...describe(c) });
          state.handled.set(step.id, { status: 'needs', note });
          continue;
        }
        if (step.verifyOnly) { if (notYet()) continue; state.report.kept.push(item); state.handled.set(step.id, { status: null }); continue; }
        if (step.ignore || (!hasValue(c) && consumedPaths().has(step.path))) { if (notYet()) continue; state.handled.set(step.id, { status: null }); continue; }
        if (identityDiffers(step, controls)) {
          if (notYet()) continue;
          state.report.noData.push({ ...item, note: IDENTITY_NOTE, reviewOnly: true, ...describe(c) });
          state.handled.set(step.id, { status: 'needs', note: IDENTITY_NOTE });
          continue;
        }
        // Answered only when the question's own text shows each of these intake words (`labelHas`:
        // GEICO's USDOT record, Yes when it shows the intake's street and ZIP: W43-24); otherwise
        // the agent's, with `labelNote`. The legend is read with its lines apart (W43-46).
        if (step.labelHas?.length && step.value != null && !step.note) {
          const text = ` ${squash(`${c.label ?? ''} ${c.text ?? ''} ${legendWords(c.radios)}`)} `;
          if (!step.labelHas.every((w) => squash(w) && text.includes(` ${squash(w)} `))) {
            if (notYet()) continue;
            state.report.noData.push({ ...item, note: step.labelNote, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note: step.labelNote });
            continue;
          }
        }
        // `onlyIf`: answered only when one of its conditions holds: a list, its own or another
        // question's (`path`; off the page it offers none), offers a limit (a choice with an amount)
        // or none, the first one holding giving its `value` (assign; GEICO's Medical Payments $5,000,
        // Not Included where it offers no limit: TNI, 2026-10-26, W44-26). Otherwise the agent's
        // alone, with `onlyNote`: a limit TNI doesn't name is never the AI's.
        if (step.onlyIf && step.value != null && !step.note) {
          if (!holdingCondition(step, c, allPairs)) {
            if (notYet()) continue;
            state.report.noData.push({ ...item, note: step.onlyNote, manualOnly: true, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note: step.onlyNote });
            continue;
          }
        }
        if (step.note || step.value == null) {
          if (notYet()) continue;
          if (step.optional) { state.handled.set(step.id, { status: null }); continue; }
          state.report.noData.push({ ...item, note: step.note, ...describe(c) });
          state.handled.set(step.id, { status: 'needs', note: step.note ?? `intake form has no answer for ${step.name}` });
          continue;
        }
        // The question it waits for isn't drawn yet, or is on the page without an answer yet: the page
        // is still working. Once it is in, what it redraws comes a moment later: the page goes quiet
        // first, and the round reads it again.
        if (step.waitFor) state.waitShown = true;
        // Something to give or wait for in the second pass: the next round's.
        if (thisRound.judgeOnly && step.waitFor && !state.waitOver.has(step.id)) { thisRound.retry = true; continue; }
        if (step.waitFor && !state.waitOver.has(step.id)) {
          const pending = shownControl(controls, { field: step.waitFor });
          const anchor = (step.whenShown ? shownControl(controls, step.whenShown)?.el : null) ?? document.body;
          const undrawn = waitedOutUndrawn.get(anchor) ?? new Set();
          const working = pending ? !hasValue(pending) && !waitedOut.has(pending.el) : !undrawn.has(step.id);
          if (working) {
            // The page is still working on what is above: the cursor stays here (a batch goes on).
            if (mayWait(step.id)) { thisRound.retry = true; thisRound.waited = true; cursor(); if (batch) continue; break; }
            if (pending) waitedOut.add(pending.el); else waitedOutUndrawn.set(anchor, undrawn.add(step.id));
            state.waitOver.add(step.id);
          } else if (state.waitingSince.has(step.id)) {
            cursor();
            state.waitOver.add(step.id);
            phase('waiting');
            await settle({ quietMs: AFTER_WAIT_QUIET_MS, maxMs: WAIT_MS, why: 'drawn' });
            thisRound.retry = true;
            thisRound.waited = true;
            break;
          }
        }
        // A pre-selected "Enter a different …" isn't an answer worth keeping for pick-not steps.
        const presetToReplace = step.kind === 'pick-not' && new RegExp(step.value.not, 'i').test(selectedText(c) ?? '') && !agreesWith(step, c);
        const isChoice = c.kind === 'radio' || c.kind === 'select' || c.kind === 'checkbox';
        // `keepChoice`: a question the carrier never pre-selects, so a differing choice already
        // there is a person's: kept and flagged, not replaced.
        // An answer an earlier fill gave here that the page has since taken back (`takenBack`).
        const tookBack = isChoice && !overwrite && !!takenBack?.keys && Object.hasOwn(takenBack.keys, fieldKey(c)) && stepIs(takenBack.steps)
          && !agreesWith(step, c) && !state.refill.has(step.id) && !state.report.filled.some((x) => x.stepId === step.id);
        const differs = isChoice && replaceChoices && !step.keepChoice && !step.keepPreset && !tookBack && !agreesWith(step, c);
        const legacyHold = mayHoldLegacyEdit(c) && !state.refill.has(step.id);
        // An unticked box that should stay unticked already has its answer (live run 2026-10-09:
        // every unticked box was "filled" again on each pass).
        const answered = hasValue(c) || (c.kind === 'checkbox' && step.value === false && !c.el.checked);
        // An answer a fill on this tab gave here (`givenBefore`: this field, for this rule's path)
        // that the field now shows otherwise, and that this fill hasn't given: the extension didn't
        // write what is there, so it is the agent's (an edit the panel never heard: closed, on
        // another tab, a page no recorder was in) or the page's. Kept and flagged, never replaced
        // (LEARN-07, 2026-11-07), unless the agent asks to replace answers (`overwrite`). One the
        // page took back (`tookBack`) is kept as that, with its own note.
        const givenHere = answered && !overwrite ? givenBefore?.[fieldKey(c)] : null;
        const changedSince = !!givenHere && givenHere.path != null && givenHere.path === step.path && givenHere.shown != null
          && !sameShown(c, givenHere.shown, answerShown(c)) && !agreesWith(step, c) && !tookBack
          && !state.refill.has(step.id) && !state.report.filled.some((x) => x.stepId === step.id);
        // A street an earlier fill left without a suggestion is not answered while the box holds
        // what that fill left: it stays the agent's, never taken as the page's.
        if (step.checkNumber && unpicked.has(c.el) && unpicked.get(c.el) === c.el.value) {
          if (notYet()) continue;
          const reason = 'no address suggestion was picked for it: pick the address yourself';
          state.report.failed.push({ ...item, code: 'address.no-suggestion', reason, ...describe(c) });
          state.handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${reason}` });
          continue;
        }
        // Replace existing answers replaces a different value; one that already is the answer is
        // kept, so nothing fires on it (FL live run 4, 2026-10-21: every Fill on GEICO's Quote &
        // Coverages set 9–12 coverages again, once right after Recalculate). An address-suggest
        // box agrees with any address, so Replace still retypes it.
        const sameAnswer = overwrite && answered && step.kind !== 'address-suggest' && agreesWith(step, c);
        // `keepPreset`: a choice the carrier already made is kept as it is, also with Replace existing
        // answers; only an empty one is answered (Progressive's anti-theft device, the VIN lookup's
        // else None: TNI, 2026-10-26, W44-32). The agent's own choice is in the fill's skip anyway.
        // One the carrier made after the fill's answer (a late VIN lookup) is kept too; the fill's
        // own answer, or an emptied list, is given again as any other.
        const presetKept = !!step.keepPreset && isChoice && answered && (!state.refill.has(step.id) || !agreesWith(step, c));
        // What a fill gave here for another vehicle, driver or trailer, still as it gave it, is
        // replaced with this unit's answer (W43-38, Progressive Add Driver, 2026-10-22: another
        // driver's name and date of birth were kept as differing and left to the agent).
        const otherUnits = answered && !agreesWith(step, c) && givenForOtherUnit(step, c);
        if (legacyHold || sameAnswer || presetKept || changedSince || (!overwrite && answered && !presetToReplace && !differs && !otherUnits && !state.refill.has(step.id) && !(step.replace && !agreesWith(step, c)))) {
          if (notYet()) continue;
          state.report.kept.push(item);
          if (legacyHold && !agreesWith(step, c)) {
            const note = 'Left as it is: an edit saved by an older version may be on this question. Check it.';
            state.report.checks.push({ ...item, note, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note });
          } else if (tookBack) {
            const note = `The page changed this back after it was filled (${step.name}): left as it is. Check it.`;
            state.report.checks.push({ ...item, note, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note });
          } else if (changedSince) {
            const note = `This was changed after it was filled (${step.name}): left as it is. Check it.`;
            state.report.checks.push({ ...item, note, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note });
          } else if (step.keepChoice && isChoice && !agreesWith(step, c)) {
            const note = `The page already has another answer here (${step.name}): left as it is. Check it.`;
            state.report.checks.push({ ...item, note, ...describe(c) });
            state.handled.set(step.id, { status: 'needs', note });
          } else {
            // Review mode confirms every retained standard, including a differing carrier choice;
            // another warning is confirmed on an answer the page already has. An answer the page
            // holds only by a fallback match (looseMatch) is checked too (the maintainer, 2026-11-07).
            const loose = looseMatch(step, c);
            const note = [step.warn && (step.reviewRequired || agreesWith(step, c)) ? step.warn : null, loose ? looseNote(step, loose, true) : null].filter(Boolean).join(' ');
            if (note) {
              state.report.checks.push({ ...item, note, ...describe(c), ...(loose ? { matched: loose.matched } : {}) });
              state.handled.set(step.id, { status: 'needs', note });
            } else state.handled.set(step.id, { status: null });
          }
          continue;
        }
        // A choice an earlier answer gave that the page has since reset (an earlier fill's, or this
        // fill's: changedSinceFilled) is given again only on a page quiet for a second, once a fill,
        // and the page is read again first (FL live run 5, 2026-10-21, W43-21: GEICO cleared the
        // business description when the agent answered the USDOT record, and the answer given again
        // a second later showed but GEICO's Next refused it). An earlier fill's key counts only for a
        // question asked once a quote: a vehicle's, driver's or trailer's form reuses its keys for the
        // next unit, where the answer is a first one. A page that doesn't go quiet gets it anyway, as
        // before.
        // `needs`: an answer the page offers only once another on its unit holds. While that one is
        // still to be given again (the page didn't keep it), this waits for it; once it didn't take,
        // this is held behind its unit's one item. A prerequisite that is the agent's (edited, or its
        // item marked done) without its answer leaves this as the page has it when the list doesn't
        // offer the answer: their call, with no item of its own.
        const prereqs = needsOf(step);
        if (prereqs.length && !agreesWith(step, c)) {
          const root = prereqs.map((p) => state.unitHeld.get(p.id) ?? state.unitHeld.get(state.heldFor.get(p.id))).find(Boolean);
          if (root) { if (notYet()) continue; holdDependent(step, root); continue; }
          // Its prerequisite, above it, is still to be given again: the cursor stays here.
          if (prereqs.some((p) => !state.handled.has(p.id) && state.refill.has(p.id) && allPairs.some((x) => x.step.id === p.id && !skippedField(x.control)))) {
            thisRound.retry = true;
            if (thisRound.judgeOnly) continue;
            cursor();
            if (batch) continue;
            break;
          }
          const theirs = prereqs.find((p) => allPairs.some((x) => x.step.id === p.id && skippedField(x.control) && !agreesWith(x.step, x.control)));
          if (theirs && isChoice && !matchOption(optionsOf(c), step)) {
            if (notYet()) continue;
            state.handled.set(step.id, { status: 'needs', note: `Left as it is: it needs ${coverageName(theirs)} on this vehicle, which you have taken over.` });
            continue;
          }
        }
        // An answer still to give, in the second pass: the next round's.
        if (thisRound.judgeOnly) { thisRound.retry = true; continue; }
        // An answer the page didn't keep is given again once the page and its own requests have been
        // quiet (`keepWait`), each time, and read again first.
        if (state.keepWait.has(step.id) && !state.keepSettled.has(step.id) && !agreesWith(step, c)) {
          cursor();
          state.keepSettled.add(step.id);
          phase('waiting');
          await settle({ quietMs: RESET_QUIET_MS, maxMs: 15000, requests: () => !state.report.halted });
          thisRound.retry = true;
          break;
        }
        if (isChoice && !state.resetWaited && !state.keepWait.has(step.id) && !agreesWith(step, c) && (state.refill.has(step.id) || (!step.scope && state.filledKeys.has(fieldKey(c))))) {
          cursor();
          state.resetWaited = true;
          phase('waiting');
          await settle({ quietMs: RESET_QUIET_MS, maxMs: 15000 });
          thisRound.retry = true;
          break;
        }
        // Timing and side effects of this answer, for working out which questions could be
        // answered together: did it reach the server, did questions appear or disappear, did
        // other answers change.
        // Batch: a field an earlier answer this round redrew is answered next round.
        if (batch && c.el.isConnected === false) { thisRound.retry = true; continue; }
        thisRound.acted = true;
        const snap = (list) => new Map(list.map((x) => [`${fieldKey(x)}|${x.label}`, x.kind === 'text' ? x.el.value : selectedText(x)]));
        const before = batch ? null : snap(controls);
        const t0 = Date.now();
        const requests0 = state.ajaxCount;
        let result;
        // The field as read after the answer (a redraw's own), for how it holds the answer.
        let judged = c;
        try { result = await apply(step, c); } catch (e) { result = { ok: false, code: 'kit.exception', reason: String(e?.message ?? e) }; }
        const tApplied = Date.now();
        if (result.ok && batch) {
          item.timing = { ms: Date.now() - t0, settleMs: 0, ajax: state.ajaxCount - requests0, revealed: 0, removed: 0, changed: 0, batch: true };
          if (state.report.halted) result = { ok: false, code: 'fill.interrupted', reason: INTERRUPTED };
          else if (c.el.isConnected === false) result = { ok: false, code: 'answer.not-kept', reason: 'the page did not keep the answer; check it' };
          else if (invalidControl(c) || !agreesWith(step, c)) result = { ok: false, code: 'answer.not-kept', reason: 'the page did not keep the answer; check it' };
        } else if (result.ok) {
          // On a page that waits on its server the redraw lands as its request ends, at most 114 ms later
          // in two Progressive recordings (84 answers, 2026-11-04): 150 ms of quiet, as elsewhere, counted
          // from the page's last change and from its last request's end (`requests`), so a request that
          // ends without a change in the page is still waited after (review of PR 284).
          const settled = await settle(serverBacked ? { quietMs: 150, requests: () => !state.report.halted, why: 'answer' } : { quietMs: 150, maxMs: 3000, why: 'answer' });
          const currentControls = collectControls();
          const after = snap(currentControls);
          const mine = `${fieldKey(c)}|${c.label}`;
          item.timing = {
            ms: Date.now() - t0, settleMs: Date.now() - tApplied, ajax: state.ajaxCount - requests0,
            revealed: [...after.keys()].filter((k) => !before.has(k)).length,
            removed: [...before.keys()].filter((k) => !after.has(k)).length,
            changed: [...before.keys()].filter((k) => k !== mine && after.has(k) && after.get(k) !== before.get(k)).length,
          };
          const fresh = assign(currentControls, plan).find((p) => p.step.id === step.id)?.control;
          if (fresh) judged = fresh;
          // An address box may collapse once a suggestion is picked; the ZIP/city rules check it.
          const accepted = fresh ? !invalidControl(fresh) && agreesWith(step, fresh) : step.kind === 'address-suggest' || summaryAccepted(step, currentControls);
          if (!settled || !accepted || state.report.halted) {
            const why = !settled ? (state.report.halted ? 'fill.interrupted' : 'page.unsettled') : !fresh ? 'field.vanished' : state.report.halted ? 'fill.interrupted' : 'answer.not-kept';
            result = { ok: false, code: why, reason: { 'fill.interrupted': INTERRUPTED, 'page.unsettled': 'the page did not settle after the answer', 'field.vanished': 'the field disappeared after the answer; check the page', 'answer.not-kept': 'the page did not keep the answer; check it' }[why],
              // The page took the question away on this answer (a summary in its place): the item is
              // about the fill's answer, kept with no field (reconcile's `offPage: 'answer'`).
              ...(settled && !fresh ? { vanished: true } : {}) };
          }
        }
        if (isTracing()) kitTrace('answer', { field: { key: item.key, label: c.label ?? '' }, stepKind: step.kind ?? null, ok: !!result.ok, start: t0, applyMs: tApplied - t0, ...(item.timing ? { timing: item.timing } : {}) });
        if (result.ok) {
          // The helpers an answer here makes due again (the adapter's `rearm`: on Progressive's
          // Rates, Recalculate and Print, and the Done of the coverage answered).
          for (const id of adapter().rearm(currentPage(), step)) {
            state.clicked.delete(id);
            state.report.actions = state.report.actions.filter((x) => x.id !== id);
            if (!state.report.invalidatedActions.includes(id)) state.report.invalidatedActions.push(id);
          }
          // A step-fenced recalculation is due again after any later answer on its step (the
          // premium showed "$ --.--" until it was clicked, and Next stayed hidden: GEICO mock run,
          // 2026-10-20). It still waits for ratesStale() and the required questions before it's
          // clicked. One clicked once a quote (`once`: GEICO's, W43-31) never is again.
          for (const a of actions.filter((x) => x.needsRecalculation && !x.once && x.steps?.length && actionHere(x))) {
            state.clicked.delete(a.action);
            state.report.actions = state.report.actions.filter((x) => x.id !== a.action);
            if (!state.report.invalidatedActions.includes(a.action)) state.report.invalidatedActions.push(a.action);
          }
          // An option picked in place of one never offered (`orMost`) is named in the report.
          const instead = state.substituted.get(step.id);
          // An option matched only by a fallback (it begins with the answer's words, or has them,
          // none reading exactly so) is written and checked by the agent (the maintainer, 2026-11-07).
          const loose = looseMatch(step, judged);
          state.report.filled.push({ ...item, shown: result.shown, ...(instead ? { said: instead } : {}), ...(loose ? { matched: loose.matched } : {}) });
          state.quietDue = true;
          state.unoffered.delete(step.id);
          state.keepWait.delete(step.id);
          // A TNI standard is marked apart from intake answers, so the agent sees the assumptions; an
          // agent's own default in place of one (source agent-default) apart from both.
          state.handled.set(step.id, step.standard
            ? { status: 'standard', note: instead ?? `TNI standard answer, not from the intake: ${step.name}` }
            : step.source === 'agent-default'
              ? { status: 'own', note: instead ?? `your own default, in place of TNI's standard: ${step.name}` }
              : { status: 'filled', note: instead ?? `filled from intake: ${step.name}` });
          const note = [step.warn, loose ? looseNote(step, loose) : null].filter(Boolean).join(' ');
          if (note) {
            state.report.checks.push({ ...item, note, ...describe(c), ...(loose ? { matched: loose.matched } : {}) });
            state.handled.set(step.id, { status: 'needs', note });
          }
          thisRound.changed = true;
          // One at a time, the cursor is here, and on a page that isn't ExtJS the next round judges
          // nothing below this answer until it acts further down (lagBound).
          if (!batch) {
            cursor();
            if (!serverBacked) state.lastAnswered = { stepId: step.id, at };
          }
          // Batch: carry on with the next answer, except before a helper button that waits on
          // this one (Import Data after the VIN list): it's clicked first thing next round.
          if (!batch || immediateAfter.has(step.path)) break;
        } else if (provisional && !step.whenOffered && result.code === 'option.no-match') {
          // Below the last answer, whose redraw may still be on its way (GEICO's UM, tried against
          // the split limits shown before the CSL limit redrew them: 2026-10-28): no item yet. The
          // cursor stays here, and the choice is tried again once the cursor is below it.
          cursor();
          thisRound.retry = true;
        } else if (step.unofferedNote && result.code === 'option.no-match') {
          // A list without the answer, which no helper shows later (GEICO's Basic PIP without
          // $2,500): the agent's alone at once, so a `whenClear` helper (Print) waits for it.
          state.report.noData.push({ ...item, note: step.unofferedNote, manualOnly: true, ...describe(c) });
          state.handled.set(step.id, { status: 'needs', note: step.unofferedNote });
        } else if (step.whenOffered && result.code === 'option.no-match') {
          // Not offered yet: a helper may show it (GEICO's 11 Payments, behind View More Payment
          // Plans). Tried again each round; never offered by the fill's end, it is the agent's.
          state.unoffered.set(step.id, { item: { ...item, ...describe(c) }, control: c, step, options: result.options ?? [] });
        } else if (result.code === 'answer.not-kept' && !state.report.halted && retryOnce(step.id)) {
          // Often a later redraw resets it (a coverage list reloading): a choice is tried again once
          // the page has settled (`keepWait`), a typed answer next round.
          state.refill.add(step.id);
          if (isChoice) state.keepWait.add(step.id);
          state.keepSettled.delete(step.id);
          thisRound.retry = true;
          // Still to give: the cursor stays here, and nothing below is answered or judged before it
          // (a batch goes on).
          cursor();
          if (!batch || serverBacked) break;
        } else if (holdUnit(step, c, item, result.reason, result.code, assign(collectControls(), plan))) {
          // A prerequisite that didn't take, with answers on its unit waiting on it (`needs`): one
          // item for the unit, not a failure for each.
          thisRound.retry = true;
          if (serverBacked) { thisRound.stopAt = Math.min(thisRound.stopAt, at + 1); break; }
        } else if (step.keepUnlisted && result.code === 'option.no-match' && hasValue(c) && !/^other\b/i.test(oneLine(selectedText(c) ?? ''))) {
          // A list without the answer that already holds the page's own (`keepUnlisted`: GEICO's
          // cities for the ZIP, TNI, 2026-10-21, W43-35: one city and OTHER in GA, "failed: City"
          // on two steps, and the agent kept GEICO's): kept, with a check naming the answer. Its
          // OTHER is no answer to keep (review of #141): that still fails.
          const note = `The page's list has no "${step.value}" (${step.name}): its "${selectedText(c)}" is left as it is. Check it.`;
          state.report.kept.push(item);
          state.report.checks.push({ ...item, note, ...describe(c) });
          state.handled.set(step.id, { status: 'needs', note });
        } else {
          state.report.failed.push({ ...item, code: result.code ?? 'kit.uncoded', reason: result.reason, ...describe(c), ...(result.vanished ? { vanished: true } : {}) });
          state.handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${result.reason}` });
          thisRound.retry = true;
          if (state.report.halted) { thisRound.stopAt = Math.min(thisRound.stopAt, at + 1); break; }
          // On pages that redraw after every answer, a failed answer may have redrawn it too: the
          // controls read this round may be gone, so read the page again before the next one. Judged
          // down to it.
          if (serverBacked) { thisRound.stopAt = Math.min(thisRound.stopAt, at + 1); break; }
        }
      }
      // Nothing left to act on in this round: what it left below the last answer is judged now,
      // from the same read (no round, read or wait of its own).
      if (pass === 0 && (!thisRound.acted || thisRound.changed) && !batch && later.length && !state.report.halted && !thisRound.stepMoved) {
        thisRound.todo = later.filter((p) => place.get(p.control) < thisRound.stopAt && p.control.el?.isConnected !== false);
        thisRound.bound = Infinity;
        thisRound.judgeOnly = true;
        continue;
      }
      break;
      }
    }
    // The round's judgments of the page's questions themselves, down to its cursor (all of them
    // when it had nothing left to act on, or for a batch), and its items streamed to the panel.
    // Once this round's own answer settled, down to it (what an answer above took off the page since
    // the round read it is no question: judgeControls passes over it).
    const judgeTo = batch || !thisRound.acted ? Infinity : thisRound.changed ? thisRound.stopAt : Math.min(thisRound.stopAt, thisRound.lagBound);
    judged(judgeTo, judgeTo === thisRound.pendingAt);
    if (thisFill.timeUp()) break;
    // The next round's start ends the fill (or stops it on a step that is the agent's).
    if (thisRound.stepMoved) continue;
    // A choice never offered once the helper that shows every option has been clicked (`orMost`:
    // GEICO's pay plans after View More Payment Plans, W43-32): the option with the highest count
    // among its question's fields is its answer, given next round.
    if (!thisRound.changed && substitute()) continue;
    // Nothing left to type or pick: click the next button whose turn it is. Not on a page the agent
    // moved to while this round answered (its answer's field gone with the old page).
    if (currentPage() !== startPage) { state.report.navigatedTo = currentPage(); break; }
    // Another group of units (`pager`), before any helper: Recalculate or the bill plan must not
    // go before every unit's rows were answered.
    const turn = !thisRound.changed && !thisRound.retry && !thisRound.waited && unitGroups.on && window === window.top && !state.agentPressed ? unitGroups.next() : null;
    // Its time spent while the round chose: no other group is shown.
    if (turn && thisFill.timeUp()) break;
    if (turn) {
      state.report.paged = unitGroups.paged;
      phase('helper', turn.text);
      pressButton(turn.el);
      state.progressed = true;
      if (!await settle(serverBacked ? {} : { quietMs: 250, maxMs: 3000 })) { stalled('The page did not settle after showing another group of vehicles. Review before retrying.'); break; }
      // Its rows drawn: the pressed group shown (where the page says which is), 10 s at most.
      for (const until = Date.now() + 10000; !unitGroups.shows(turn.text) && Date.now() < until && !state.report.halted;) await pause(200);
      if (!await settle(serverBacked ? {} : { quietMs: 250, maxMs: 3000 })) { stalled('The page did not settle after showing another group of vehicles. Review before retrying.'); break; }
      if (currentPage() !== startPage) { state.report.navigatedTo = currentPage(); break; }
      continue;
    }
    thisRound.helperClicked = false;
    if (!thisRound.changed && helpersHere && !state.agentPressed) {
      state.loadDue = null;
      thisRound.changed = thisRound.helperClicked = clickNextAction(controls);
      // A helper that loads a view (GEICO's "+", Add Driver) is clicked on a page quiet for a
      // second (FL live run 4, 2026-10-21: Add Driver 2 s after the list showed, and GEICO's
      // spinner stayed until the agent reloaded), and one that waits for a quiet page for its own
      // time (`quietMs`: GEICO's Recalculate, W43-31), its own requests included (REQUESTS_MS at
      // most): once it is due, the page is waited for, and clicked next round if nothing changed
      // meanwhile (a page that changed is read again).
      if (state.loadDue) {
        const before = signature();
        const due = actions.find((x) => x.action === state.loadDue);
        phase('waiting');
        if (!await settle({ quietMs: due?.quietMs ?? LOAD_QUIET_MS, maxMs: LOAD_MS, requests: due?.quietMs ? () => !state.report.halted : null, why: 'before-load' })) { stalled(LOAD_HALT); break; }
        state.quiet = !state.agentPressed && signature() === before ? { action: state.loadDue, sig: before } : null;
        continue;
      }
    }
    state.progressed = thisRound.changed;
    if (!thisRound.changed && !thisRound.retry) {
      // A fill with a step that waits on the page takes one more look once the page has gone quiet:
      // an answer the page cleared after the last round read it (GEICO fills its type list again a
      // moment after the decoded year: FL live run 3, the Cascadia's Tractor) is given again
      // (changedSinceFilled).
      if (!state.lastLook && state.waitShown && state.report.filled.length && window === window.top) {
        state.lastLook = true;
        phase('waiting');
        await settle({ quietMs: AFTER_WAIT_QUIET_MS, maxMs: WAIT_MS, why: 'drawn' });
        continue;
      }
      // GEICO draws some questions a moment after the answer that asks them, once that answer's
      // wait is over (team driving and the hazmat placard after "more about the business": FL live
      // run, 2026-10-23). Drawn during the wait before Continue, the fill never read them, the
      // recorder took them as the fill's when it resumed, and nobody answered them until the agent
      // did. Where Continue waits for a quiet page (`advance.quietMs`), a fill that gave answers waits
      // for it here, before it ends, and answers what was drawn, again after each later answer. (A
      // fill that gave none has drawn nothing: one the agent's answer drew, the recorder reports.)
      // Not after the agent's own Next: the step's move is theirs, and no Continue follows. The
      // wait counts as progress: a fill whose rounds run out on it, with what it drew unread, stops
      // at its round limit and doesn't continue.
      if (state.quietDue && !state.agentPressed && advance?.quietMs && !serverBacked && window === window.top && currentPage() === startPage && !stepChanged()
        && (!advance.steps?.length || stepIs(advance.steps, stepKey()))) {
        state.quietDue = false;
        state.progressed = true;
        phase('waiting');
        await settle({ quietMs: advance.quietMs, maxMs: 6000 });
        state.quietSig = signature();
        continue;
      }
      // Nothing left to do: a choice that failed against options the page has redrawn since is
      // tried once more against the ones it shows now (retryRedrawn), in the next round.
      if (retryRedrawn(allPairs)) { state.progressed = true; continue; }
      break;
    }
    if (!thisRound.changed) {
      if (thisRound.waited) await pause(WAIT_ROUND_MS);
      continue;
    }
    // An answer given one at a time has already waited for the page (above); only a helper
    // click or a batch of answers still needs the wait. (Waiting twice cost Progressive about
    // 0.3 s per answer.)
    // A helper that draws a new view (`loads`: GEICO's add icons and the chooser's Next) is waited
    // for as long as a step's load, and so is one that rates the quote (GEICO's Recalculate, its
    // spinner up while it rates).
    const loads = thisRound.helperClicked && !!state.pendingAction?.loads;
    const rates = thisRound.helperClicked && state.pendingAction?.verify === 'premium';
    if (thisRound.helperClicked) phase('helper', state.pendingAction?.label ?? state.report.actions.at(-1)?.text ?? null);
    if ((thisRound.helperClicked || batch) && !await settle(serverBacked ? { why: 'round' } : { quietMs: batch ? 150 : 250, maxMs: loads || rates ? LOAD_MS : 3000, why: 'round' })) {
      traceEnd(state.pendingAction);
      stalled(loads ? LOAD_HALT : 'The page did not settle after the helper.');
      break;
    }
    // Its view comes a moment after the page went quiet (GEICO's chooser after "+", with no
    // spinner: FL live run 4, 2026-10-21, "+" clicked three times in 1.4 s): waited for, once
    // the page is quiet again, before the click counts as lost. So is a page it opens (`{ page }`:
    // Progressive's business type Search, whose first request went out 0.3 s after the click, by
    // when the wait above had ended, and "Ok, start quote." followed while the popup loaded; AZ
    // live recording, 2026-11-05).
    const opens = state.pendingAction?.verify?.page ?? null;
    if (loads && (state.pendingAction?.verify === 'revealed' || opens)) {
      const until = Date.now() + loadResultMs;
      let dirty = true;
      const mo = new MutationObserver(() => { dirty = true; });
      mo.observe(document.body, { subtree: true, childList: true });
      try {
        // Stopped meanwhile (the agent's Stop, or an edit): the wait ends there, and the fill with it
        // (CodeRabbit review of #290: otherwise it held the panel up to `loadResultMs`).
        for (let tick = 0; Date.now() < until && !state.report.halted; tick++) {
          if ((dirty || tick % 5 === 0) && (opens ? currentPage() === opens : revealedNow(state.pendingAction))) break;
          dirty = false;
          await pause(200);
        }
      } finally {
        mo.disconnect();
      }
      if (state.report.halted) { traceEnd(state.pendingAction); break; }
      if (!await settle({ quietMs: 250, maxMs: LOAD_MS, why: 'load' })) { stalled(LOAD_HALT); break; }
    }
    // One that rates the quote on a page that isn't ExtJS (GEICO's Recalculate) shows nothing
    // busy at first: GEICO's loader shows only 3 s into a load. GEICO rated the fill's click 13 to
    // 19 s after it (2026-10-22). The wait above had ended by then, so the click was failed as
    // unrated, and GEICO's redraw with its own values was never checked. Its premium is waited for
    // as long as a step's load. Then the page and its own requests are waited for, quiet for the
    // helper's own time, before the answers are read (W43-41, FL, 2026-10-22). Read 250 ms after the
    // premium showed, four answers the agent saw right the whole time were marked as changed by
    // GEICO.
    if (rates && !serverBacked) {
      phase('premium');
      const until = Date.now() + LOAD_MS;
      while (Date.now() < until && !rated(state.pendingAction) && !state.report.halted && currentPage() === startPage && !stepChanged()) { traceRead(state.pendingAction); await pause(500); }
      if (state.pendingAction?.trace && rated(state.pendingAction)) { state.pendingAction.trace.premiumMs = Math.round(perfNow() - state.pendingAction.trace.at); traceRead(state.pendingAction); }
      // Stopped, or the agent edited, while it rated: nothing more is done here.
      if (state.report.halted) { traceEnd(state.pendingAction); break; }
      // A Stop during GEICO's redraw after the premium ends this wait too (the maintainer, 2026-11-07):
      // nothing more is put back or read for the answers.
      if (!await settle({ quietMs: state.pendingAction?.quietMs ?? 250, maxMs: LOAD_MS, requests: () => !state.report.halted, why: 'rated' })) { traceEnd(state.pendingAction); stalled(LOAD_HALT); break; }
      if (state.report.halted) { traceEnd(state.pendingAction); break; }
      traceRead(state.pendingAction);
    }
    if (!await verifyAction()) break;
    if (currentPage() !== startPage) {
      state.report.navigatedTo = currentPage();
      // The wait above held until the new page was drawn and quiet (`settledAt`).
      if (serverBacked && thisRound.helperClicked) settledAt = { at: Date.now(), page: currentPage(), sig: signature() };
      break;
    }
    if (stepChanged()) break;
  }
  // The agent's step after the last round (Next clicked during its wait): stopped there too.
  if (!state.stoppedAt) {
    state.stoppedAt = stopStepOn(stopSteps);
    if (state.stoppedAt) { state.report.stopStep = state.stoppedAt; if (!state.report.halted) halt(STOP_STEP_HALT); }
  }

  function revealedNow(a) {
    const before = a.before ?? new Map();
    const controls = collectControls();
    return [...controlSnapshot(controls)].some(([k, v]) => !before.has(k) || before.get(k) !== v)
      || resultShown(a, assign(controls, plan));
  }

  async function verifyAction() {
    const a = state.pendingAction;
    state.pendingAction = null;
    if (!a) return true;
    if (a.verify === 'download') {
      state.report.documentPending = true;
      return true;
    }
    let accepted = true;
    if (a.verify === 'premium') accepted = rated(a);
    // Clicked once a quote (`once`: GEICO's Recalculate, W43-31): never again, also when its
    // result didn't show; from here it is the agent's, and they're told.
    if (!accepted && a.once) {
      state.report.failed.push({ label: a.label ?? 'Recalculate', path: null, name: a.label ?? a.action, key: null, q: null, controlKind: null, code: 'action.unverified', reason: ONCE_UNVERIFIED });
      traceEnd(a);
      return false;
    }
    // The answers it may have redrawn (`keepAnswers`), read again once its result shows, and
    // watched until KEPT_WATCH_MS after the click when they held.
    if (accepted && a.kept && !await answersKept(a)) await watchKept(a);
    traceEnd(a);
    // A link that opens a section (Add Non-Trucking Liability) is gone once it took; still on
    // screen but disabled is not gone.
    if (a.verify === 'gone') accepted = !findButton(a, { disabledToo: true });
    // A coverage section's Done (cargo's, general liability's, trailer interchange's): its questions are gone and the
    // row keeps the limit (sectionClosedOn).
    if (CLOSED_SECTIONS[a.verify]) accepted = sectionClosedOn(collectControls(), CLOSED_SECTIONS[a.verify]);
    // `revealed`: the click showed its result: a question appeared, or an answer changed, since
    // the snapshot taken as the button was clicked (a lookup's decoded values, the rows an
    // import redraws, the registered names a USDOT check offers). A redraw of the same
    // questions with the same answers is no result.
    // A redraw that shows the result again unchanged (it was there before the click) counts too.
    if (a.verify === 'revealed') accepted = revealedNow(a);
    // `{ appears }`: more of these on the page than before the click (any, when there were none).
    if (a.verify?.appears) accepted = deepQueryAll(document, a.verify.appears).length > (a.before ?? 0);
    // `{ page }`: the click opened that page (Progressive's business type Search, its popup).
    if (a.verify?.page) accepted = currentPage() === a.verify.page;
    if (!accepted) {
      state.clicked.delete(a.action);
      state.report.invalidatedActions.push(a.action);
      state.report.actions = state.report.actions.filter((x) => x.id !== a.action);
      state.report.blocked.push({ id: a.action, why: 'result not verified yet' });
      // A click whose result never showed is tried again, twice at most in one fill (the
      // button is due again, being unclicked); then it stays the agent's, and they're told.
      if (a.verify === 'revealed' || a.verify?.appears || a.verify?.page) {
        // A helper that loads a view is never clicked again: it was waited for (above).
        if (a.loads) {
          state.exhausted.add(a.action);
          state.report.noData.push({ label: a.label ?? a.baseAction ?? a.action, path: a.path, name: a.name, key: null, q: null, controlKind: null,
            note: 'Clicked once, but the page never showed what it opens: check the page, do it yourself if it isn\'t there, then fill again.' });
          return true;
        }
        if (retryOnce(`action:${a.action}`)) return true;
        // Left to the agent for the rest of this fill (not clicked again), and the page's other
        // questions still fill around it.
        state.exhausted.add(a.action);
        state.report.noData.push({ label: a.label ?? a.baseAction ?? a.action, path: a.path, name: a.name, key: null, q: null, controlKind: null,
          note: 'Clicked three times, but the page never showed its result: do it yourself, then fill again.' });
        return true;
      }
    }
    return accepted;
  }

  // A helper's result already on the page (`shownBy`), for the unit's own value: the helper's
  // fields show the intake's value, and this fill didn't type them (an older result would then
  // be another value's). A click alone never counts.
  function resultShown(a, pairs) {
    const shown = a.shownBy;
    if (!shown || !a.after.length) return false;
    if (state.report.filled.some((x) => a.after.includes(x.path))) return false;
    const agrees = (p) => pairs.some(({ step, control }) => step.path === p && step.value != null && !invalidControl(control) && agreesWith(step, control));
    const present = (p) => pairs.some(({ step, control }) => step.path === p && !invalidControl(control) && (!shown.answered || hasValue(control)));
    return a.after.every(agrees) && (shown.all.length ? shown.all.every(present) : shown.any.some(present));
  }

  // What the page's questions show, by question: the snapshot a `revealed` check compares with.
  function controlSnapshot(controls) {
    return new Map(controls.map((x) => [`${fieldKey(x)}|${x.label}`, x.kind === 'text' ? x.el.value : selectedText(x)]));
  }

  // The intake unit a form names (`formUnit`: { list, text, names, active, label }, Progressive's
  // "Questions about <driver>" on Add Driver for a driver it already has), by the words of each
  // unit's name (`names`), all of them in the form's: `index` the plan's unit when it is one of
  // those named, the only one named otherwise, null for none or several. Null when the page
  // names none (a new driver's blank form).
  function unitNamedNow() {
    const re = new RegExp(formUnit.text, 'i');
    const line = String(document.body?.innerText ?? '').split(/\n+/).map((l) => l.trim()).find((l) => re.test(l));
    if (!line) return null;
    const name = (re.exec(line)?.[1] ?? '').trim();
    const words = ` ${name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
    const all = (formUnit.names ?? []).flatMap((n, i) => (n.length && n.every((w) => words.includes(` ${w} `)) ? [i] : []));
    // A driver whose name words another named driver's also holds (Ann Lee beside Mary Ann Lee) is not the one named.
    const most = Math.max(0, ...all.map((i) => formUnit.names[i].length));
    const named = all.filter((i) => formUnit.names[i].length === most);
    return { name, index: named.includes(formUnit.active) ? formUnit.active : named.length === 1 ? named[0] : null };
  }
  // Whether the field shows just what an earlier fill gave for another unit of the plan step's
  // list (`givenBefore`: field key -> { path, shown }, the panel's record of this tab's answers).
  function givenForOtherUnit(step, c) {
    // Only on a form that names its unit (`unitNames`), where a form naming another unit halts.
    if (!formUnit) return false;
    const given = givenBefore?.[fieldKey(c)];
    const unit = (path) => String(path ?? '').match(/^(vehicles|drivers|trailers)\[(\d+)\]/);
    const mine = unit(step.path);
    const theirs = unit(given?.path);
    return !!mine && !!theirs && mine[1] === theirs[1] && mine[2] !== theirs[2] && given.shown != null && String(given.shown) === String(answerShown(c) ?? '');
  }
  // Each question by its field and its place among the fields of that key (`key#n`): a GEICO
  // coverage row's label holds its premium, which a recalculation changes.
  function answerPlaces(controls) {
    const seen = new Map();
    return controls.map((c) => {
      const key = fieldKey(c);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return [`${key}#${n}`, c];
    });
  }
  function answerShown(c) {
    return c.kind === 'text' ? c.el.value : selectedText(c);
  }
  // The same answer shown, a list's several picks ("a; b") in any order: a fill reports them in
  // the answer's order, the page reads them back in its own (review of PR #374).
  function sameShown(c, a, b) {
    if (c.kind === 'text') return loose(a) === loose(b);
    const picks = (v) => String(v ?? '').split(/;\s*/).map(loose).sort().join(';');
    return picks(a) === picks(b);
  }

  // The answers on the page as a helper that redraws them is clicked (`keepAnswers`: GEICO's
  // Recalculate, W43-31): the fill's (any fill's, the page agreeing with its step) and the agent's.
  function answersNow() {
    const controls = collectControls();
    const pairs = assign(controls, plan);
    return answerPlaces(controls).flatMap(([at, c]) => {
      if (!hasValue(c)) return [];
      const step = pairs.find((p) => p.control === c)?.step;
      const agents = skippedField(c);
      const ours = !agents && !!step && step.value != null && !step.ignore && !step.note && !step.verifyOnly && agreesWith(step, c);
      return agents || ours ? [{ at, stepId: ours ? step.id : null, shown: answerShown(c), label: c.label, key: fieldKey(c), kind: c.kind }] : [];
    });
  }

  // What the page did after the click of a helper that rates the answers (`keepAnswers`: GEICO's
  // Recalculate), for the usage log (W43-44, to tell a check read too early from GEICO drawing its
  // own values): each kept choice's value whenever it changed, in ms after the click; how it was
  // pressed (pressButton: 'page', 'late' or 'kit'); when the premium showed; the page's requests
  // from 10 s before the click on; and which answers the fill put back. Typed boxes are left out
  // (they may hold a client's value). `now`: the controls already read.
  function traceStart() {
    return { at: perfNow(), press: null, last: new Map(), seen: [], premiumMs: null, putBack: [] };
  }
  function traceRead(a, now = null) {
    const t = a?.trace;
    if (!t) return;
    now ??= new Map(answerPlaces(collectControls()));
    const ms = Math.round(perfNow() - t.at);
    for (const k of a.kept) {
      const c = now.get(k.at);
      if (!c || k.kind === 'text' || c.kind === 'text') continue;
      const value = answerShown(c);
      if (value === (t.last.has(k.at) ? t.last.get(k.at) : k.shown)) continue;
      t.last.set(k.at, value);
      if (t.seen.length < 120) t.seen.push({ at: k.at, ms, value });
    }
  }
  function traceEnd(a) {
    const t = a?.trace;
    if (!t) return;
    traceRead(a);
    const rel = (x) => Math.round(x - t.at);
    state.report.recalcTrace = {
      action: a.action,
      ms: rel(perfNow()),
      press: t.press,
      premiumMs: t.premiumMs,
      requests: recentRequests.filter((r) => r.end >= t.at - 10000).slice(-40).map((r) => (r.poll ? [rel(r.start), rel(r.end), 1] : [rel(r.start), rel(r.end)])),
      answers: a.kept.filter((k) => k.kind !== 'text').map((k) => ({
        label: k.label, key: k.key, shown: k.shown, agents: k.stepId == null,
        seen: t.seen.filter((s) => s.at === k.at).slice(0, 10).map((s) => [s.ms, s.value]),
        putBack: t.putBack.includes(k.at),
      })),
    };
  }

  // Once its result shows (W43-31: GEICO drew its own choices back after a Recalculate the fill
  // clicked): an answer the page shows otherwise now is given back once if it was the fill's, and
  // left as it is if it was the agent's. Each is red, and one more item says the premium may not
  // be for the answers shown. The helper isn't clicked again (`once`): the agent recalculates,
  // and Print waits for them (`whenClear`).
  // Whether any answer had changed.
  function keptChanged(a, now) {
    return a.kept.flatMap((k) => {
      const c = now.get(k.at);
      return c && answerShown(c) !== k.shown ? [{ k, c }] : [];
    });
  }
  async function answersKept(a) {
    if (!keptChanged(a, new Map(answerPlaces(collectControls()))).length) return false;
    // A change counts only if it is still there once the page and its own requests have been
    // quiet again. A request still running can't be seen, and a value the page then draws back
    // by itself isn't a change (W43-41, FL, 2026-10-22: four answers marked as changed and put
    // back, which the agent saw right the whole time).
    await settle({ quietMs: a.quietMs ?? 1000, maxMs: LOAD_MS, requests: () => !state.report.halted });
    if (state.report.halted) return false;
    const now = new Map(answerPlaces(collectControls()));
    traceRead(a, now);
    const changed = keptChanged(a, now);
    if (!changed.length) return false;
    const pairs = assign([...now.values()], plan);
    const given = new Set();
    // What the page showed instead, before anything is put back.
    const seen = new Map(changed.map(({ k, c }) => [k.at, answerShown(c)]));
    for (const { k, c } of changed) {
      // Stopped meanwhile (Stop, or the agent's edit): nothing more is put back; nor an answer the
      // agent has made theirs.
      if (state.report.halted) break;
      const step = k.stepId != null ? pairs.find((p) => p.control === c && p.step.id === k.stepId)?.step : null;
      if (!step || skippedField(c)) continue;
      let result;
      try { result = await apply(step, c); } catch (e) { result = { ok: false }; }
      if (result.ok) { given.add(k.at); a.trace?.putBack.push(k.at); }
    }
    if (given.size) await settle({ quietMs: 250, maxMs: LOAD_MS });
    const after = new Map(answerPlaces(collectControls()));
    for (const { k, c: before } of changed) {
      const c = after.get(k.at) ?? before;
      const step = k.stepId != null ? plan.find((s) => s.id === k.stepId) : null;
      // A choice's own words only (a typed box may hold a client's value).
      const was = c.kind === 'text' ? '' : ` (it was "${k.shown}")`;
      const back = !!step && given.has(k.at) && after.has(k.at) && agreesWith(step, c);
      const reason = !step ? `the page changed your answer when it recalculated${was}: answer it again, then click Recalculate yourself.`
        : back ? `the page changed this answer when it recalculated${c.kind === 'text' ? '' : ` (to "${seen.get(k.at)}")`}, and the fill put it back: click Recalculate yourself, then check the answer is kept.`
          : `the page changed this answer when it recalculated${was}, and the fill couldn't put it back: answer it yourself, then click Recalculate.`;
      const key = fieldKey(c);
      // Only this answer's own entry (its step, key and label): another field with its key (a
      // sibling, another step's) keeps its own. The agent's answer has none.
      const own = (list) => {
        const i = step ? list.findIndex((x) => x.stepId === step.id && x.key === key && x.label === c.label) : -1;
        return i < 0 ? list : list.filter((_, j) => j !== i);
      };
      state.report.filled = own(state.report.filled);
      state.report.kept = own(state.report.kept);
      state.report.failed.push({ stepId: step?.id ?? null, label: c.label, path: step?.path ?? null, name: step?.name ?? c.label, key, q: c.q ?? null, controlKind: c.kind, code: 'answer.changed', reason, ...describe(c) });
      mark(c, 'failed', reason);
      if (step) state.handled.set(step.id, { status: 'failed', note: reason });
    }
    const n = changed.length;
    state.report.failed.push({ label: a.label ?? 'Recalculate', path: null, name: a.label ?? a.action, key: null, q: null, controlKind: null, code: 'answer.changed',
      reason: `the page changed ${n === 1 ? 'an answer' : `${n} answers`} when it recalculated (marked above), so the premium may not be for the answers shown. Check them and click Recalculate yourself: the fill clicks it once a quote.` });
    return true;
  }

  // A redraw after the first check (GEICO's came 9 to 14 s after the click): the answers are read
  // again every half second until KEPT_WATCH_MS after the click, and a change is checked as above
  // once the page is quiet. An agent edit, another page or another step ends the watch.
  async function watchKept(a) {
    while (Date.now() - a.clickedAt < KEPT_WATCH_MS && !state.report.halted && currentPage() === startPage && !stepChanged()) {
      await pause(500);
      const now = new Map(answerPlaces(collectControls()));
      traceRead(a, now);
      if (!keptChanged(a, now).length) continue;
      await settle({ quietMs: a.quietMs ?? 1000, maxMs: LOAD_MS, requests: () => !state.report.halted });
      await answersKept(a);
      return;
    }
  }

  // A choice never offered once the helper that shows every option was clicked (`orMost`: GEICO's
  // pay plans, W43-32: TX offers no 11 Payments): among the options of every field of its
  // question, the one with the highest count (`count`'s first group; `one`: an option that counts
  // 1) becomes its answer, given next round and named in the report. Clicked by an earlier fill,
  // the page may have drawn fewer plans since: only the page's own pick, when it is that one (a
  // later fill agrees with the 9 Payments the first picked). No option with a count, or one of its
  // fields already answered: still the agent's.
  function substitute() {
    const byPath = new Map();
    for (const u of state.unoffered.values()) {
      const m = u.step.orMost;
      if (!m || !state.clicked.has(m.after)) continue;
      byPath.set(u.step.path, [...(byPath.get(u.step.path) ?? []), u]);
    }
    let any = false;
    for (const [path, group] of byPath) {
      if (state.report.filled.some((x) => x.path === path) || plan.some((s) => s.path === path && state.substituted.has(s.id))) continue;
      const { count, one, name } = group[0].step.orMost;
      const counted = (text) => (one && new RegExp(one, 'i').test(text) ? 1 : Number(new RegExp(count, 'i').exec(text)?.[1] ?? NaN));
      let best = null;
      for (const u of group) {
        for (const text of u.options) {
          const n = counted(oneLine(text));
          if (Number.isFinite(n) && (!best || n > best.n)) best = { n, text: oneLine(text), id: u.step.id, control: u.control };
        }
      }
      if (!best) continue;
      const fresh = state.report.actions.some((x) => x.id === group[0].step.orMost.after);
      if (!fresh && oneLine(selectedText(best.control) ?? '') !== best.text) continue;
      const step = plan.find((s) => s.id === best.id);
      state.substituted.set(step.id, `The page doesn't offer "${step.value}" here: the fill picked "${best.text}", ${name}.`);
      step.value = best.text;
      state.unoffered.delete(step.id);
      any = true;
    }
    return any;
  }

  // A helper's own pages, and its own steps of a one-address application (`steps`: GEICO's
  // Recalculate only on Quote & Coverages; a later step's text can ask to recalculate too).
  function actionHere(a) {
    return (!a.pages.length || a.pages.includes(currentPage())) && (!a.steps?.length || stepIs(a.steps));
  }

  // A helper the agent must otherwise do by hand is open while the helpers it follows have run
  // and the page hasn't settled it (NTL added, then set back to No, and still on the quote).
  function holdOpen(a) {
    return !!a.missing && a.afterActions.every((id) => state.clicked.has(id)) && !state.clicked.has(a.action)
      && actionHere(a) && !settledItem(a);
  }

  // A coverage section added and closed (CLOSED_SECTIONS): none of its questions on screen (found
  // by the rules tagged for it), and its row keeps the limit.
  // Checking the fill's own Done: the intake's limit (with `anyLimit`, any limit when the intake
  // has none), or the row's `words` showing the intake's amounts.
  // `found` (a section the fill finds closed, by the agent or an earlier fill): the intake's limit
  // or one the agent set themselves, not one this fill put in (a limit chosen in the row adds the
  // coverage, whose section Progressive hasn't drawn yet), and never by the row's words.
  function sectionClosedOn(controls, section, { found = false } = {}) {
    const { tag } = section;
    if (assign(controls, plan).some(({ step }) => step[tag] === 'section')) return false;
    // The row's limit steps, assigned among themselves (cargo's row and section read the same).
    const limitSteps = plan.filter((s) => s[tag] === 'limit' && (s.value != null || (section.anyLimit && !found)));
    const kept = ({ step, control }) => (found
      ? !state.report.filled.some((x) => x.key === fieldKey(control))
        && (agreesWith(step, control) || (skippedField(control) && hasValue(control)))
      : (!section.anyLimit || hasValue(control)) && (step.value == null || agreesWith(step, control)));
    if (assign(controls, limitSteps).some(kept)) return true;
    if (found || !section.words) return false;
    const amounts = moneyTokens((document.body.innerText ?? '').match(section.words)?.[0] ?? '');
    return limitSteps.some((s) => moneyTokens(s.value).length >= 2 && moneyTokens(s.value).every((n) => amounts.includes(n)));
  }

  // Its button back on the page (`resolvedBy`: the Add NTL link, NTL removed), or a page the agent
  // has been to since (`settledByPages`).
  function settledItem(a) {
    return !!(a.resolvedBy && findButton({ text: a.resolvedBy })) || !!a.settledByPages?.some((p) => state.visited.has(p));
  }

  // A prerequisite holds when its field shows the intake's answer, or an answer the agent chose
  // themselves (their correction counts as resolved). Missing, rejected or different: not yet.
  function answered(pairs, path) {
    return pairs.some(({ step, control }) => step.path === path && !step.ignore && !invalidControl(control)
      && ((step.value != null && agreesWith(step, control)) || (skippedField(control) && hasValue(control))));
  }

  // What this fill has left for the agent so far (`whenClear` helpers wait for none): its needs-you,
  // failed and check items, an answer kept that differs, and an empty question it reported as
  // unfamiliar (only those the panel lists, so the agent can answer or mark each one done).
  // Only items whose question is on the page now count (liveOn): one an answer took off the page
  // holds nothing (GEICO, 2026-10-28: Property Damage Liability, gone once the liability limit was
  // CSL, held Recalculate until the agent marked it done).
  function leftForAgent(controls) {
    const here = liveOn(controls);
    return state.report.noData.filter(here).length + state.report.failed.filter(here).length + state.report.checks.filter(here).length + state.report.leftRequired.filter(here).length
      // An answer the page didn't keep, still to give again (`keepWait`): not done yet.
      + [...state.keepWait].filter((id) => !state.handled.has(id)).length
      + state.report.kept.filter((x) => x.differs && here(x)).length
      + controls.filter((c) => !hasValue(c) && !skippedField(c) && state.report.unknown.some((x) => x.key === fieldKey(c))).length
      // Questions below the round's cursor, not judged yet: what they hold isn't known.
      + state.provisionalLeft;
  }

  // The place of the first question in `pairsNow` the fill hasn't settled (not answered, kept or
  // left yet, and not the agent's): at most where the round's cursor is (Infinity: none).
  function firstOpen(pairsNow, place) {
    let first = Infinity;
    for (const { step, control } of pairsNow) if (!state.handled.has(step.id) && !skippedField(control)) first = Math.min(first, place.get(control) ?? Infinity);
    return first;
  }

  // What the panel streams while the fill runs (progress): the items judged so far, each with its
  // place on the page as this round read it (`order`), in one snapshot a round (`at`), and the
  // places the answers' rows take from the same read.
  function streamItems(controls) {
    const at = new Map();
    controls.forEach((c, i) => {
      const key = fieldKey(c);
      if (!at.has(`${key}|${c.label}`)) at.set(`${key}|${c.label}`, i);
      if (!at.has(key)) at.set(key, i);
    });
    const order = (x) => (x.key == null ? null : at.get(`${x.key}|${x.label}`) ?? at.get(x.key) ?? null);
    const lists = [['unknown', state.report.unknown], ['failed', state.report.failed], ['noData', state.report.noData], ['leftRequired', state.report.leftRequired], ['differs', state.report.kept.filter((x) => x.differs)], ['checks', state.report.checks]];
    thisFill.places = order;
    // In page order; those with no field on the page (a helper, a unit without its row) last.
    const list = lists.flatMap(([kind, xs]) => (/** @type {any[]} */ (xs)).filter((x) => !x.otherStep).map((x) => ({ kind, key: x.key ?? null, label: x.label || x.name || '', order: order(x) })));
    list.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    thisFill.items = { at: (thisFill.items?.at ?? 0) + 1, list };
  }

  // What the report says of the page holds only for questions on it (the invariant in
  // docs/browser-filling.md, "Only what is on the page"). An answer may take questions off the page
  // or redraw them after the fill read them (GEICO, 2026-10-28: a CSL liability limit removes
  // Property Damage Liability and UMPD and redraws UM's limits as CSL), so the items are checked
  // against the page as the fill ends.
  // `offPage`: an item whose field isn't on screen now but is still this page's question, as the
  // kit knows: read while another group of units was shown ('group': `pager`), or in a coverage
  // section the page closes ('section': CLOSED_SECTIONS, Progressive's cargo, GL and trailer
  // interchange behind their Done); or an item about the fill's own answer, whose field the page
  // took away on it ('answer': a summary in its place, `vanished`), which the agent still checks.
  // And one whose field is in the page but not shown or open now ('hidden': a collapsed card such as
  // GEICO's cargo after Recalculate, a section closed), as `controls`, the read, found it.
  function offPage(x, controls) {
    return x.vanished ? 'answer' : x.key != null && unitGroups.readElsewhere(x.key) ? 'group' : x.stepId != null && closable.has(x.stepId) ? 'section'
      : x.key != null && hiddenKeys(controls).has(x.key) ? 'hidden' : null;
  }
  // A row the intake doesn't have (pairs.extraRows): its check's key is the row's own token, no field's.
  function rowCheck(x) { return String(x.key ?? '').startsWith('extra-row:'); }
  // Whether a report item's question is on the page `controls` were read from: its field, by its
  // key or by the rule that found it (a row whose key moved), or one off screen for now (offPage).
  // An item with no field (a helper, a unit without its row) is.
  function liveOn(controls) {
    const index = keyIndex(controls);
    let steps = null;
    return (x) => {
      if (x.key == null || rowCheck(x) || index.has(x.key) || offPage(x, controls)) return true;
      if (x.stepId == null) return false;
      steps ??= new Set(assign(controls, plan).map((p) => p.step.id));
      return steps.has(x.stepId);
    };
  }
  // The report made to agree with one read of the page as the fill ends (`now`, with `pairsNow`,
  // assign's pairs of it): an item whose field is gone (and isn't offPage) is dropped, so it is no
  // blocker and the panel never lists it; each other one takes what its field shows and offers now
  // (describe), never what an earlier round read, and its key and label where its rule now finds
  // another row. Answers (filled, and kept as the page had them) stay in the report, for what the
  // fill did (the usage log, the panel's bookkeeping), each with what its field shows now (`now`,
  // shownNow: the panel shows that, never what the fill put in), `changed` when that is no longer
  // the fill's answer ('you': a field the agent took over; 'page': the page's change), and `gone`
  // when its field isn't on the page (the panel shows no row for it). `reads`: the page reads
  // since the rounds ended, said in `report.reconcile` with its time (`ms`), the items it dropped
  // and the answers gone.
  function reconcile(now, pairsNow, reads = null) {
    const t0 = perfNow();
    const index = keyIndex(now);
    const byStep = new Map(pairsNow.map((p) => [p.step.id, p.control]));
    const rows = new Set((pairsNow.extraRows ?? []).map((r) => r.key));
    const steps = new Map(plan.map((s) => [s.id, s]));
    let dropped = 0;
    let gone = 0;
    const answer = (x, filled) => {
      if (x.key == null || rowCheck(x)) return;
      const ruled = x.stepId != null ? byStep.get(x.stepId) ?? null : null;
      const { c, sure } = ruled ? { c: ruled, sure: true } : controlOf(index, x.key, x.label);
      delete x.now;
      delete x.changed;
      if (!c) {
        const off = offPage(x, now);
        if (off) { x.offPage = off; delete x.gone; } else { x.gone = true; delete x.offPage; gone++; }
        return;
      }
      delete x.gone;
      delete x.offPage;
      if (!sure) return;
      x.now = shownNow(c);
      // Not the fill's answer any more: neither what it put in nor the answer as the fill judges it
      // (a ZIP+4, an address in the page's own format, the plan picked in place of one never offered).
      const step = steps.get(x.stepId);
      if (filled && step && loose(x.now) !== loose(x.shown) && !agreesWith(step, c)) x.changed = skippedField(c) ? 'you' : 'page';
    };
    const live = (x) => {
      if (x.key == null) return true;
      if (rowCheck(x)) {
        if (rows.has(x.key)) return true;
        dropped++;
        return false;
      }
      const ruled = x.stepId != null ? byStep.get(x.stepId) ?? null : null;
      const { c, sure } = ruled ? { c: ruled, sure: true } : controlOf(index, x.key, x.label);
      if (!c) {
        const off = offPage(x, now);
        if (!off) { dropped++; return false; }
        // Not on screen now: nothing it shows is the page's now; a field taken away offers nothing.
        x.offPage = off;
        if ('current' in x) x.current = null;
        if (off === 'answer' && 'options' in x) x.options = [];
        return true;
      }
      delete x.offPage;
      const key = fieldKey(c);
      if (key !== x.key) Object.assign(x, { key, label: c.label, q: c.q ?? null });
      if ('controlKind' in x) x.controlKind = c.kind;
      // A row of a shared key that can't be told now shows nothing as the page's.
      if ('current' in x || 'options' in x) Object.assign(x, sure ? describe(c) : { current: null });
      return true;
    };
    for (const k of REVIEW_LISTS) state.report[k] = state.report[k].filter(live);
    state.report.kept = state.report.kept.filter((x) => !x.differs || live(x));
    for (const x of state.report.filled) answer(x, true);
    for (const x of state.report.kept) if (!x.differs) answer(x, false);
    const was = state.report.reconcile;
    state.report.reconcile = { ms: Math.round(((was?.ms ?? 0) + perfNow() - t0) * 100) / 100, reads: reads ?? was?.reads ?? 0, dropped: (was?.dropped ?? 0) + dropped, gone, retried: redrawRetried.size };
  }
  // A choice that failed against options the page has redrawn since (GEICO, 2026-10-28: UM was tried
  // against the split limits shown before the CSL liability limit redrew them as CSL) is given once
  // more, against the options on the page now: taken off the report, the next round answers it as
  // any other answer. Once a fill (redrawRetried); never after a halt or the agent's own button.
  function retryRedrawn(pairsNow) {
    if (state.report.halted || state.agentPressed) return false;
    const byStep = new Map(pairsNow.map((p) => [p.step.id, p]));
    let again = false;
    for (const x of [...state.report.failed]) {
      const pair = x.stepId == null || redrawRetried.has(x.stepId) ? null : byStep.get(x.stepId);
      if (!pair || !Array.isArray(x.options) || !['radio', 'select'].includes(pair.control.kind) || skippedField(pair.control)) continue;
      const { step, control } = pair;
      if (step.value == null || step.note || step.ignore || step.verifyOnly) continue;
      const options = describe(control).options;
      if (options.length === x.options.length && options.every((o, i) => o === x.options[i])) continue;
      redrawRetried.add(step.id);
      state.report.failed = state.report.failed.filter((y) => y !== x);
      state.handled.delete(step.id);
      again = true;
    }
    return again;
  }

  function clickNextAction(controls, immediateOnly = false) {
    // A page the plan has questions for that shows none yet is still drawing: its helpers wait for
    // them, a tile pick aside (W44-03, Progressive Business Owner Info in KY and OH, 2026-10-26: the
    // business type's Search was the only thing to do on the undrawn page, its click counted as
    // something done there, and "Ok, start quote." followed it).
    const blank = !controls.length && expectsQuestions && currentPage() === startPage;
    const pairs = assign(controls, plan);
    const has = (path) => answered(pairs, path);
    const blocked = [];
    // A helper's button with something open over it: waits, as one waiting for its prerequisites.
    const holdCovered = (a, el) => {
      blocked.push(a.action);
      state.report.blocked.push({ id: a.action, why: COVERED_HELPER, waits: [{ say: 'what is open over it closed' }], text: buttonText(el).slice(0, 60) || (a.label ?? '') });
    };
    for (const a of actions.filter((x) => (!immediateOnly || x.immediate) && (!blank || x.onBlankPage) && (window === window.top || x.inFrame))) {
      // A link verified by its going away that is back on its page (NTL removed by hand, then
      // asked for again) is due again.
      if (state.clicked.has(a.action) && a.verify === 'gone' && actionHere(a) && findButton(a)) state.clicked.delete(a.action);
      if (state.clicked.has(a.action) || state.exhausted.has(a.action) || !actionHere(a)) continue;
      // A blank repeater row is already sufficient: do not add a duplicate merely because
      // its fields have not been filled yet (or the agent went back to this step).
      if (a.unlessSelector && deepQueryAll(document, a.unlessSelector).length) { state.clicked.add(a.action); continue; }
      // A helper that answers many questions at once (AmWINS' Default all answers to No) would
      // reset an answer the agent gave on this page: not clicked while one is here (the rules
      // answer the other questions one by one), and not counted as clicked either.
      if (a.skipIfProtected && controls.some((c) => skippedField(c))) continue;
      if (state.report.halted || pageBusy()) return false;
      if (a.action === 'printSend' && controls.some((c) => /^(email|e mail|fax)$/.test(c.text) && hasValue(c))) {
        state.report.blocked.push({ id: a.action, why: 'Email or Fax is ticked; untick it to print' });
        continue;
      }
      if (a.unless.some(has) || (a.unlessActions ?? []).some((id) => state.clicked.has(id))) { state.clicked.add(a.action); continue; }
      // A coverage section already added and closed on the page, by the agent or an earlier fill:
      // its Done is done, unclicked, so what follows it runs (general liability's "+" after cargo:
      // the maintainer, 2026-10-28, after an FL run where the agent closed cargo and GL was never
      // added). Only as this fill found the page (after a click of its own, a "+", a section still
      // being drawn isn't closed), and with no Done with this coverage showing (a section is open).
      if (CLOSED_SECTIONS[a.verify] && !state.report.actions.some((x) => !x.alreadyShown) && !findButton(a)
        && sectionClosedOn(controls, CLOSED_SECTIONS[a.verify], { found: true })) {
        state.clicked.add(a.action);
        state.report.actions.push({ id: a.action, text: 'closed on the page', alreadyShown: true });
        continue;
      }
      // Recalculate only when the rates are out of date; otherwise it isn't waited for.
      if (a.needsRecalculation && !ratesStale()) continue;
      const button = findButton(a);
      // `nudge`: a button that shows only once the page took an answer (Progressive's "Done with
      // this coverage" after the cargo commodity): with everything else ready and no button, that
      // answer is picked again, once (the agent's re-pick is what made it show).
      if (!button && a.nudge && !state.nudged.has(a.action) && a.after.every(has) && a.afterActions.every((id) => state.clicked.has(id))) {
        const pair = pairs.find(({ step }) => step.path === a.nudge && step.value != null);
        if (pair && agreesWith(pair.step, pair.control)) {
          // Its time spent meanwhile: nothing more is written.
          if (thisFill.timeUp()) return false;
          state.nudged.add(a.action);
          // A widget is picked again its own way (the page adapter's reselect), a field set again.
          const { widget } = pair.control;
          if (widget) adapter().reselect(widget, pair.control.el);
          else setNativeValue(pair.control.el, pair.control.el.value);
          return true;
        }
      }
      // Menu items ("Add Vehicle" under "Add") only show once their menu button is opened.
      const alreadyShown = a.verify === 'revealed' && resultShown(a, pairs);
      if (!button && !a.opener && !alreadyShown) continue;
      const holds = actions.filter((h) => (a.heldBy ?? []).includes(h.baseAction) && holdOpen(h));
      // A page button that the carrier refuses while a required question is empty (Rates' bill
      // plan, SC 2026-10-07: clicked right after UM/UIM were cleared, and nothing opened).
      const openRequired = a.waitRequired ? controls.filter((c) => c.required && !hasValue(c) && !skippedField(c)) : [];
      const leftOpen = a.whenClear ? leftForAgent(controls) : 0;
      const ready = !holds.length && !openRequired.length && !leftOpen && (!a.afterAny?.length || a.afterAny.some(has))
        && (!a.needsPremium || premiumReady())
        && (!a.needsRecalculation || ratesStale())
        && a.after.every(has)
        && a.afterActions.every((id) => state.clicked.has(id))
        && (!a.afterPages.length || a.afterPages.some((p) => state.visited.has(p)))
        && (!a.afterValue || pairs.some(({ step, control }) => step.path === a.afterValue[0] && new RegExp(a.afterValue[1], 'i').test(selectedText(control) ?? '')));
      if (!ready) {
        // Name what it waits for (field paths, buttons, pages: no client values), so the panel
        // and the usage log say why a helper didn't run: `why` for the log, and `waits` (the same,
        // by kind) to tell, at the end of the fill, one the page did itself (doneByPage).
        const waits = [
          ...a.after.filter((p) => !has(p)).map((path) => ({ path })),
          ...(a.afterAny?.length && !a.afterAny.some(has) ? [{ any: a.afterAny }] : []),
          ...a.afterActions.filter((id) => !state.clicked.has(id)).map((action) => ({ action })),
          ...(a.afterPages.length && !a.afterPages.some((p) => state.visited.has(p)) ? [{ pages: a.afterPages }] : []),
          ...(a.needsPremium && !premiumReady() ? [{ say: 'a current premium' }] : []),
          ...(a.afterValue ? [{ path: a.afterValue[0], set: true }] : []),
          ...holds.map((h) => ({ action: h.action, say: `${h.label ?? h.baseAction} resolved` })),
          ...openRequired.slice(0, 3).map((c) => ({ say: `${c.label || 'a required question'} answered` })),
          ...(leftOpen ? [{ say: NOTHING_LEFT }] : []),
        ];
        const waitingFor = waits.map((w) => w.say ?? (w.any ? `one of ${w.any.join(' / ')}` : w.action ? `${w.action} clicked`
          : w.pages ? `${w.pages.join(' / ')} visited` : `${w.path}${w.set ? ' set' : ''}`));
        blocked.push(a.action);
        state.report.blocked.push({ id: a.action, why: waitingFor.length ? `waiting for ${waitingFor.join(', ')}` : 'waiting for its prerequisites', waits });
        continue;
      }
      // Its result already shows (the agent ran the lookup before Fill): done, not clicked again.
      if (alreadyShown) {
        state.clicked.add(a.action);
        state.report.actions.push({ id: a.action, text: 'already shown on the page', alreadyShown: true });
        continue;
      }
      if (!button) {
        const opener = !state.openersTried.has(a.action) && findButton({ text: a.opener });
        if (!opener) continue;
        // Something open over it (a dialog, a message): not clicked through it.
        if (coveredBy(opener)) { holdCovered(a, opener); continue; }
        // Its time spent meanwhile: nothing more is clicked.
        if (thisFill.timeUp()) return false;
        state.openersTried.add(a.action);
        state.report.actions.push({ id: `${a.action}:menu`, text: buttonText(opener).slice(0, 60) });
        pressButton(opener);
        return true;
      }
      if ((a.loads || a.quietMs) && !(state.quiet?.action === a.action && state.quiet.sig === signature())) { state.loadDue = a.action; return false; }
      // Something open over it (a dialog, a message): not clicked through it; clicked once it's gone.
      if (coveredBy(button)) { holdCovered(a, button); continue; }
      // Its time spent meanwhile: nothing more is clicked.
      if (thisFill.timeUp()) return false;
      state.quiet = null;
      state.clicked.add(a.action);
      state.report.actions.push({ id: a.action, text: buttonText(button).slice(0, 60) || (a.label ?? '') });
      // What the page shows as the button is clicked (the round's controls are older: answers
      // have landed since): what a `revealed` / `appears` check compares with afterwards.
      state.pendingAction = a.verify === 'revealed' ? { ...a, before: controlSnapshot(collectControls()) }
        : a.verify?.appears ? { ...a, before: deepQueryAll(document, a.verify.appears).length }
          : a.keepAnswers ? { ...a, kept: answersNow(), clickedAt: Date.now(), trace: traceStart() } : a;
      const trace = state.pendingAction.trace;
      const how = pressButton(button, { late: trace ? () => { trace.press = 'late'; } : null, kit: a.kitClick });
      if (trace) trace.press = how;
      return true;
    }
    return false;
  }

  return await finishFill();

  // The end of a fill, once its rounds are over: what the page shows now is read once more, the
  // report is put together (items, blockers, what moved), and Continue is pressed when it may be.
  async function finishFill() {
    // A helper that opened the next page (the vehicle tile opens Add Vehicle) leaves its questions
    // to that page's own fill: none of them is reported or marked as this page's. So does the
    // agent's Next to another step of a one-address application, and a stop step or a step that
    // can't be read is not read at all.
    const stillHere = !state.report.navigatedTo && currentPage() === startPage && !stepChanged() && !state.stoppedAt && !state.unreadStep;
    // Answers still waiting for another try when the fill ended are left for the agent, and so is
    // a field the page should have filled itself (emptyNote) but didn't.
    // The page's questions are read once here for the end of the fill: these checks, the marks, the
    // report's labels and order, and its reconciliation with the page (reconcile).
    const endReads = getControlReads();
    const finalControls = stillHere ? collectControls() : [];
    const finalPairs = stillHere ? assign(finalControls, plan) : [];
    // A unit form drawn after the last round read the page has its own edits, never the last one's.
    if (skipBy && stillHere) skipWhere(finalPairs.units);
    identityAfterAnswer(finalPairs, finalControls);
    // A unit whose row the page's rows don't show (its VIN on none of them, or on two): its
    // answers stay the agent's, once per unit, naming it and not its VIN.
    for (const step of finalPairs.unwitnessed ?? []) {
      const unit = unitName(step.witness.path);
      if (state.report.noData.some((x) => x.unit === unit)) continue;
      const why = step.witness.value == null ? `the intake has no ${witnessName(step.witness)} for ${unit}` : `the row for ${unit} (its ${witnessName(step.witness)}) wasn't found`;
      state.report.noData.push({ label: unit.replace(/^\w/, (ch) => ch.toUpperCase()), path: step.witness.path, name: unit, unit, key: null, q: null, controlKind: null, note: `${why}; check the rows and answer its questions yourself.` });
    }
    // A unit whose row no group of the page showed (`pager`): none of its questions was answered,
    // and it is the agent's, named, never taken for done.
    if (stillHere) state.report.noData.push(...unitGroups.missing());
    // A row showing a VIN no intake vehicle has: an unintended vehicle may be on the quote. Left
    // as it is (never removed or answered); Continue waits for the agent. Named by its place only.
    for (const { witness, position, key } of finalPairs.extraRows ?? []) {
      if (skippedKey(key)) continue;
      const kind = String(witness.path ?? '').match(/^(\w+?)s?\[/)?.[1] ?? 'unit';
      const label = `${kind.replace(/^\w/, (ch) => ch.toUpperCase())} row ${position || '?'} on the page`;
      if (state.report.checks.some((x) => x.label === label)) continue;
      state.report.checks.push({ label, path: null, name: label, key, q: null, controlKind: null,
        note: `Its ${witnessName(witness)} matches no ${kind} on the intake. Remove it, or dismiss this check to confirm it belongs on this quote, before continuing.` });
    }
    for (const { step, control } of finalPairs) {
      if (step.emptyNote && !hasValue(control) && !skippedField(control)) {
        state.report.noData.push({ stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind, note: step.emptyNote, ...describe(control) });
        state.handled.set(step.id, { status: 'needs', note: step.emptyNote });
        continue;
      }
      if ((!state.refill.has(step.id) && !state.waitingSince.has(step.id)) || state.handled.has(step.id) || skippedField(control) || agreesWith(step, control)) continue;
      // One that waited for the page to the end (the fill stopped first) is as unanswered as one the page reset.
      const reason = state.refill.has(step.id) ? 'the page did not keep the answer; check it' : 'the page was still working on this question; check it';
      const base = { stepId: step.id, label: control.label, path: step.path, name: step.name, key: fieldKey(control), q: control.q ?? null, controlKind: control.kind };
      // With answers on its unit waiting on it (`needs`): one item for the unit, as in a round.
      if (state.refill.has(step.id) && holdUnit(step, control, base, reason, 'answer.not-kept', finalPairs)) continue;
      state.report.failed.push({ ...base, code: state.refill.has(step.id) ? 'answer.not-kept' : 'page.unsettled', reason, ...describe(control) });
      state.handled.set(step.id, { status: 'failed', note: `couldn't fill ${step.name}: ${reason.replace(/; check it$/, '')}` });
    }
    // Out of rounds with questions still below the cursor, never judged (it waited on the page to the
    // end): the same, as nothing said of them may be taken for nothing left.
    if ((state.progressed || state.judgedTo !== Infinity) && state.report.rounds === maxRounds && !state.report.halted) halt('Filling reached its round limit. Check the page before retrying.');
    // The page may have redrawn while filling, so mark the final fields: those just read, the page
    // unchanged since (only the report changed). Read again only when the fill left its page.
    const controls = state.stoppedAt || state.unreadStep ? [] : stillHere ? finalControls : collectControls();
    const pairs = assign(controls, plan);
    if (skipBy && stillHere) skipWhere(pairs.units);
    for (const { step, control } of stillHere ? pairs : []) {
      const h = state.handled.get(step.id);
      if (h?.status) mark(control, h.status, h.note);
    }
    // A held unit form is marked on its first question, where its check says why.
    for (const u of stillHere ? pairs.units : []) if (u.held && !skippedField(u.marker)) mark(u.marker, 'needs', heldFormNote(u));
    // So is a unit's row no unit matched (its check names the row).
    for (const { control, step } of stillHere ? pairs.unmatchedRows : []) if (!skippedField(control)) mark(control, 'needs', unmatchedRowNote(step));
    // An unfamiliar question that went away during the fill (hidden by an answer, such as the
    // equipment amount once "no equipment" is ticked) isn't one the agent has to answer.
    if (stillHere) {
      const onPageNow = keyIndex(controls);
      state.report.unknown = state.report.unknown.filter((x) => onPageNow.has(x.key) || unitGroups.readElsewhere(x.key));
      // Likewise a field that looked renamed (Codex on PR #43): it no longer holds Continue.
      state.report.renamed = state.report.renamed.filter((x) => onPageNow.has(x.key));
    }
    // Question text for every field on the page, keyed like the usage recorder's changes.
    state.report.labels = controls.map((c) => [fieldKey(c), c.label]);
    // Each widget list's loaded choices (an ExtJS combo's; never agency staff lists), so the usage
    // log can tell a pick from text typed into the box.
    state.report.choices = controls.filter((c) => c.widget && c.kind === 'select' && c.options && !/agent|producer/i.test(c.label ?? ''))
      .map((c) => [fieldKey(c), [...new Set(c.options.map((o) => o.text).filter(Boolean))]]);
    state.report.skipped = controls.filter((c) => skippedField(c)).map((c) => ({ label: c.label, key: fieldKey(c) }));
    const matched = new Set(pairs.map((p) => p.control));
    for (const c of stillHere ? controls : []) {
      if (!matched.has(c) && state.report.unknown.some((x) => x.key === fieldKey(c)) && !skippedField(c)) mark(c, 'needs', 'Unfamiliar question — left for you.');
      if (!matched.has(c) && c.required && !hasValue(c) && !skippedField(c) && !pairs.held.has(c)) {
        state.report.leftRequired.push({ label: c.label, key: fieldKey(c), q: c.q != null ? String(c.q) : null, controlKind: c.kind, ...describe(c) });
        mark(c, 'needs', 'required, and not on the intake form');
      }
    }
    // A choice never offered (`whenOffered`), unless another rule for the same question answered it
    // (GEICO's two pay plan groups, one of which lists 11 Payments), or a helper that may show it is
    // still waiting (View More Payment Plans, for the agent's answers, or for a Recalculate: GEICO hides
    // the link while the premium is out of date): the agent's, or the offered plan with the most (`orMost`).
    const offerPending = state.report.blocked.some((x) => !state.clicked.has(x.id) && x.waits?.some((w) => w.say === NOTHING_LEFT))
      || (state.unoffered.size > 0 && actions.some((a) => a.needsPremium && !state.clicked.has(a.action) && actionHere(a)) && !premiumReady());
    for (const { item, control, step } of state.unoffered.values()) {
      if (state.handled.has(step.id) || offerPending || state.report.filled.some((x) => x.path === step.path) || state.report.kept.some((x) => x.path === step.path)) continue;
      const note = `The page doesn't offer "${step.value}" here: pick it yourself.`;
      state.report.noData.push({ ...item, note });
      state.handled.set(step.id, { status: 'needs', note });
      mark(control, 'needs', note);
    }
    // A helper the agent must otherwise do by hand (the vehicle tile) that couldn't be clicked here,
    // once the helpers it follows have run (an NTL still on the quote after the agent set it to No).
    if (window === window.top && currentPage() === startPage && !stepChanged() && !state.stoppedAt && !state.unreadStep) {
      for (const a of actions) {
        if (!a.missing || state.clicked.has(a.action) || !actionHere(a) || findButton(a)
          || !a.afterActions.every((id) => state.clicked.has(id)) || a.unlessActions?.some((id) => state.clicked.has(id))
          || settledItem(a)) continue;
        // A markable one carries its own id, scoped as `clicked` has it, for the panel's Mark done.
        state.report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.missing, action: a.markable ? a.action : null });
      }
      // Clicked earlier, but what it adds never got in (Add Trailer opened, the trailer page left
      // without filling it): the agent finishes it before Continue. A helper kept to a container
      // (`within`: GEICO's add row) says so only where its list is on screen, not on the unit's
      // own form, which one address draws in its place.
      for (const a of actions) {
        if (!a.unfinished || !a.doneWhen?.length || !state.clicked.has(a.action) || a.doneWhen.some((id) => state.clicked.has(id))
          || !actionHere(a) || (a.within && !findButton(a, { disabledToo: true }))) continue;
        state.report.noData.push({ label: a.label ?? a.name, path: a.path, name: a.name, key: null, q: null, controlKind: null, note: a.unfinished });
      }
    }
    // A button that was waiting earlier in this fill and got clicked later isn't waiting any more.
    // Nor is one that waited only for answers the page now shows, once the page took the button
    // away: Progressive looked a second vehicle's VIN up by itself once it was typed (SC
    // 2026-10-19), and the panel still said Look up VIN was waiting for the VIN. The page did it,
    // so it's done, unclicked, as one already shown is: a helper that follows it (Add Trailer after
    // every vehicle's lookup) doesn't wait for it either. One still waiting for another helper, a
    // page or a premium stays, as does a menu item (`opener`: shown only with its menu open) and a
    // helper the agent must do by hand (`missing`, reported above).
    const doneByPage = (b) => {
      if (!stillHere || !b.waits?.length || !b.waits.every((w) => w.path && !w.set && answered(pairs, w.path))) return false;
      const a = actions.find((x) => x.action === b.id);
      return !!a && !a.opener && !a.missing && !findButton(a);
    };
    for (const b of state.report.blocked) {
      if (state.clicked.has(b.id) || !doneByPage(b)) continue;
      state.clicked.add(b.id);
      state.report.actions.push({ id: b.id, text: 'done by the page itself', alreadyShown: true });
    }
    // Each helper once, with what held it last (its prerequisites in one round, something open over
    // it in the next).
    state.report.blocked = state.report.blocked.filter((b, i, all) => !state.clicked.has(b.id) && all.findLastIndex((x) => x.id === b.id) === i);
    // Helpers still held by something open over them: the panel names them (`coveredHelpers`).
    const coveredHelpers = state.report.blocked.filter((b) => b.why === COVERED_HELPER).map((b) => b.text);
    if (coveredHelpers.length) state.report.coveredHelpers = coveredHelpers;
    // The items as the page is now, from the read above (no read or wait of its own): one whose
    // question is gone is no item and holds nothing; the others say what the page shows now.
    if (stillHere) reconcile(controls, pairs, getControlReads() - endReads);
    // Where each item's field is on the page (`order`: its place among the page's questions, in
    // document order), so the side panel lists what's left in the page's order, whichever kind
    // of item it is. Read once, from the page as it is now (as the last round read it when a
    // helper opened the next page). An item with no field there (a helper, a unit without its row,
    // a field gone since) gets none: the panel lists it last.
    const placeOf = new Map();
    (stillHere ? controls : state.roundControls).forEach((c, i) => {
      const key = fieldKey(c);
      if (!placeOf.has(`${key}|${c.label}`)) placeOf.set(`${key}|${c.label}`, i);
      if (!placeOf.has(key)) placeOf.set(key, i);
    });
    // Answers filled too: the panel lists the whole page in one list, in this order.
    for (const x of [state.report.filled, state.report.unknown, state.report.failed, state.report.noData, state.report.leftRequired, state.report.kept, state.report.checks].flat()) {
      // Rows of one question share a key; their labels tell them apart.
      const at = x.key == null ? undefined : placeOf.get(`${x.key}|${x.label}`) ?? placeOf.get(x.key);
      if (at !== undefined) x.order = at;
    }
    // Anything the agent should look at before moving on.
    // The carrier probably changed this page: a known field renamed, or most of its questions
    // unfamiliar at once. Continue waits for the agent, and the panel says so.
    state.report.pageChanged = state.report.renamed.length > 0 || (state.report.unknown.length >= 5 && state.report.unknown.length >= 0.4 * Math.max(1, state.report.fields));
    // A field drawn without a caption (the cargo commodity lists) is named after its rule.
    const called = (x) => x.label || x.name || x.path || 'a question with no label';
    state.report.blockers = [
      ...(state.report.pageChanged ? [`page changed: ${state.report.unknown.length} unfamiliar question(s)${state.report.renamed.length ? `, ${state.report.renamed.length} known field(s) renamed` : ''}`] : []),
      // An unfamiliar question with no answer yet is left for the agent even when the page
      // doesn't mark it required (Progressive validates some only on Continue).
      ...state.report.unknown.filter((x) => x.required || x.current == null).map((x) => `unfamiliar: ${called(x)}`),
      ...state.report.noData.map((x) => `needs you: ${called(x)}`),
      ...state.report.failed.map((x) => `failed: ${called(x)}`),
      ...state.report.leftRequired.map((x) => `required: ${called(x)}`),
      ...state.report.kept.filter((x) => x.differs).map((x) => `differs: ${called(x)}`),
      // Another step's hidden fields (otherStep: AmWINS' prior carriers, filled again on every
      // step) are confirmed on their own step, not again on each later one (audit 2026-10-10).
      ...state.report.checks.filter((x) => !x.otherStep).map((x) => `check: ${called(x)}`),
      ...state.report.blocked.map((x) => `button: ${x.id}${x.why?.startsWith('waiting for ') ? ` (${x.why})` : ''}`),
      ...(state.report.halted ? [state.report.reason] : []),
      // The agent's own button during the fill (Next, "+", Looks Good): that step's move is theirs.
      ...(state.agentPressed ? [AGENT_PRESSED] : []),
    ];
    if (state.agentPressed) state.report.agentPressed = true;
    // The step this fill was on: the one it started on when the agent moved to another meanwhile
    // (its items are that step's).
    state.report.stepKey = stepChanged() ? startStep : stepKey();
    // A page the plan expects questions on that shows none yet, with nothing done on it, is still
    // drawing (Business Owner Info right after the state is picked, OK 2026-10-07): Continue there
    // only gets "fields are empty" errors. (A tile page that was clicked continues.) Only a frame of
    // the page in front says so: Progressive keeps a hidden frame loaded with Business Owner Info's
    // address for the whole quote, and on every later page it found none of "its" questions and said
    // the page wasn't drawn, so the panel took the top frame's held Continue for "No questions found"
    // and filled the page once more (live recording, 2026-10-24). On a page the plan has questions for,
    // only a tile pick is done while it shows none (clickNextAction, W44-03).
    const notDrawn = !state.report.fields && !state.report.actions.length && (state.topPage == null || state.topPage === startPage) && plan.some((s) => s.pages?.includes(startPage));
    // The panel tries such a page again in a moment, and says nothing of it yet (W43-42).
    if (notDrawn && !state.report.halted) state.report.notDrawn = true;
    // Continue only on a page or step the carrier lists (`pages`, `steps`: the maintainer,
    // 2026-11-07, audit ENG-01): one it doesn't list, a page the carrier added or renamed, is
    // answered and left for the agent. Done there with a Continue showing that would have been
    // clicked, the report says so (`unlisted`): the panel tells the agent, and the log names it.
    const listed = !advance || ((!advance.pages?.length || advance.pages.includes(currentPage()))
      && (!advance.steps?.length || (!!state.report.stepKey && stepIs(advance.steps, state.report.stepKey))));
    if (advance && !listed && window === window.top && !state.report.blockers.length && !notDrawn && !state.report.halted
      && currentPage() === startPage && !stepChanged() && !(advance.exceptPages ?? []).includes(currentPage())
      && findAdvanceButton(advance.text, advance)) state.report.unlisted = true;
    if (advance && listed && window === window.top && !state.report.blockers.length && !notDrawn && currentPage() === startPage && !stepChanged() && !pageBusy()
      && !(advance.exceptPages ?? []).includes(currentPage()) && !doneSteps.includes(state.report.stepKey)) {
      // The last answer may still be redrawing part of the page (a new payment method reloads the
      // plan list): a Continue clicked meanwhile is lost. Let it finish first. `quietMs`: a page that
      // draws a question a moment after an answer (GEICO's USDOT record check) is waited for too,
      // unless the fill's own wait at the end of its rounds left it as it is now. Held for the agent's
      // check with nothing approved yet (`hold`), Continue isn't clicked: the wait is the page's, not
      // Continue's (the panel's dock read "Clicking Continue…" there: the review of PR #170).
      // On a page that waits on its server, the last answer's wait left nothing for this one in all
      // 17 of two recordings (Progressive, 2026-11-04): 250 ms is enough to see a late redraw.
      phase(hold && confirmed == null ? 'waiting' : 'continue');
      if (serverBacked) await settle({ quietMs: 250, maxMs: 6000, why: 'continue' });
      else if (advance.quietMs && state.quietSig !== signature()) await settle({ quietMs: advance.quietMs, maxMs: 6000, why: 'continue' });
      // The report as the page is after that wait, from one read (reconcile), halted or not.
      const now = collectControls();
      const nowPairs = assign(now, plan);
      reconcile(now, nowPairs);
      // An agent edit during that wait stopped the fill (the guard is still on): no Continue, and
      // the report says why. (Reproduced 2026-10-08: halted, and Continue clicked all the same.)
      if (state.report.halted) {
        if (!state.report.blockers.includes(state.report.reason)) state.report.blockers.push(state.report.reason);
      } else {
        // The carrier may have rewritten an answer during that wait (a late server response). An
        // answer whose field no longer shows it is the agent's to check (no retry here): it moves
        // to `failed`, is marked, and Continue waits.
        const changed = changedSinceFilled(nowPairs);
        for (const { previous, pair } of changed) {
          const item = { ...previous, code: /** @type {FailCode} */ ('answer.changed'), reason: 'The carrier changed this answer after it was filled; check it.', ...describe(pair.control) };
          const at = placeOf.get(`${item.key}|${item.label}`) ?? placeOf.get(item.key) ?? now.indexOf(pair.control);
          if (at >= 0) item.order = at;
          state.report.filled = state.report.filled.filter((x) => x !== previous);
          state.report.failed.push(item);
          mark(pair.control, 'failed', 'the carrier changed this answer after it was filled');
          state.report.blockers.push(`failed: ${called(item)}`);
        }
        // A registered name drawn during that wait, after the fill's last check, makes an answer
        // given before it the agent's to verify, as during the fill: marked, and Continue waits.
        const moved = identityAfterAnswer(nowPairs, now);
        for (const { item, control } of moved) {
          const at = placeOf.get(`${item.key}|${item.label}`) ?? placeOf.get(item.key) ?? now.indexOf(control);
          if (at >= 0) item.order = at;
          mark(control, 'needs', IDENTITY_NOTE);
          state.report.blockers.push(`needs you: ${called(item)}`);
        }
        // A question drawn during that wait without an answer (`quietMs`) holds Continue: the fill
        // never read it, so it is the agent's. (What the page drew during the fill's own wait at the
        // end of its rounds, the fill read and answered.)
        const readKeys = new Set(finalControls.map((c) => fieldKey(c)));
        const drawn = advance.quietMs ? now.filter((c) => !readKeys.has(fieldKey(c)) && !hasValue(c)) : [];
        const found = !changed.length && !moved.length && !drawn.length && !pageBusy() && currentPage() === startPage && !stepChanged() ? findAdvanceButton(advance.text, advance) : null;
        // Per form and button (`byForm`): one already continued from is the agent's now.
        const key = found && advance.byForm ? [state.report.stepKey, squash(buttonText(found)), unitFormsNow()?.[0]?.id ?? ''].filter(Boolean).join('@') : state.report.stepKey;
        const button = found && !(advance.byForm && doneSteps.includes(key)) ? found : null;
        // Nothing held Continue, but none could be clicked: the page still busy after the wait
        // ('busy') or showing no Continue (`none`: not drawn yet, disabled, or a list's Looks Good
        // left out). The panel tries an automatic fill once more, and logs which (`advanceDue`,
        // W43-40: Progressive's Vehicle Summary, every vehicle added, not continued on 2026-10-22
        // with nothing said why; continued 3 of 3 times on earlier builds with the switch on).
        if (!found && !changed.length && !moved.length && !drawn.length && !state.report.halted && !state.agentPressed) state.report.advanceDue = pageBusy() ? 'busy' : 'none';
        // The agent checks the answers first: Continue only for the page as they approved it.
        const approved = !hold || (confirmed != null && confirmed === receipt());
        if (button && !approved) state.report.held = confirmed == null ? 'check' : 'changed';
        // Pressed during the wait before Continue: held as above.
        if (button && approved && state.agentPressed) {
          state.report.agentPressed = true;
          state.report.blockers.push(AGENT_PRESSED);
        } else if (button && approved && coveredBy(button)) {
          // Something is open over Continue (a dialog, a message, a mask): a script's click would
          // go through it. Continue waits until the agent closes it.
          state.report.covered = true;
          state.report.blockers.push(COVERED);
        } else if (button && approved && !thisFill.timeUp()) {
          const text = buttonText(button).slice(0, 40);
          // On one-address applications (AmWINS) the side panel waits for the questions to change.
          state.report.signatureBefore = signature();
          pressButton(button);
          // Recorded once the press went out (on GEICO the page's world clicks a moment later, within
          // a second at most), never before it.
          state.report.advanced = text;
          if (advance.byForm) state.report.advanceKey = key;
          // On a page that waits on its server, Continue's request takes a second or more and the
          // button stays on screen meanwhile. A second Continue sent during it broke the quote
          // (Progressive, recording of 2026-11-04: the agent clicked it 0.7 s after the fill did;
          // Filings drew, then Progressive's error page). The fill lasts until the page is done
          // with it, so no follow-up fill starts on the page being left, and an agent's click on a
          // Continue meanwhile is not passed to the page (the maintainer, 2026-11-04).
          if (serverBacked && window === window.top) {
            const re = new RegExp(advance.text, 'i');
            const repeat = (event) => {
              if (!event.isTrusted) return;
              const path = event.composedPath?.() ?? [event.target];
              if (!path.some((n) => n?.nodeType === 1 && safeMatches(n, agentPress()) && re.test(buttonText(n)))) return;
              event.preventDefault();
              event.stopImmediatePropagation();
              state.report.repeatsHeld = (state.report.repeatsHeld ?? 0) + 1;
            };
            document.addEventListener('click', repeat, true);
            const pressedAt = perfNow();
            try {
              // A Stop meanwhile doesn't end this wait (`abort: null`): Continue's request is the page's
              // until it is done, and the click guard above holds until then.
              const done = await settle({ quietMs: 250, maxMs: LOAD_MS, why: 'continued', abort: null });
              // The next page drawn and quiet, as after a helper that opens one (`settledAt`).
              if (done && currentPage() !== startPage) settledAt = { at: Date.now(), page: currentPage(), sig: signature() };
              // Quiet, still on this page, and nothing sent to the server: the page refused Continue in
              // the browser (Progressive's own check, a question it requires still blank, says so at its
              // top; recording of 2026-11-04, Snapshot Pro: no request). A Continue that goes through
              // always posts. Not reported as continued, so the panel doesn't press it again 6 s later and
              // then pause its automatic fills; the agent's answer there fills and continues as usual.
              else if (done && currentPage() === startPage && !stepChanged() && watchingRequests() && !recentRequests.some((r) => r.start >= pressedAt - 5)) {
                delete state.report.advanced;
                delete state.report.advanceKey;
                state.report.continueRefused = text;
                state.report.blockers.push(CONTINUE_REFUSED);
              }
            } finally {
              document.removeEventListener('click', repeat, true);
            }
          }
        }
      }
    }
    resolveItems(state.report, plan);
    return state.report;
  }
  } finally {
    setHiddenOk([]);
    setFillUnits(null);
    adapter().offRequest(countAjax);
    releaseEditGuard();
    document.removeEventListener('click', notePress, true);
    clearTimeout(budget);
    if (running === thisFill) running = null;
  }
}
