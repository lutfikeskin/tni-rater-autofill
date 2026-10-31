// The side panel: usage recording (see src/usage.js for what is and isn't kept).
// One part of the panel; sidepanel.js wires the parts together.
import { buildPlan, redactionTerms } from '../../src/plan.js';
import { fieldChangeEvent, fillEvents, redactor, knownStep } from '../../src/usage.js';
import { quoteStatePick } from '../../src/quote-state.js';
import * as usage from '../usage-log.js';
import { inExtension } from './env.js';
import { $, persistAgentKeys, persistDoneActions, settleRejectedAi, state } from './core.js';
import { releaseDiscardedForms } from './record.js';
import { noteChangedAfterDone, noteQuoteDone, noteQuoteState, onQuotePage, renderSteps, scheduleAutoFill, scheduleLayout, seedQuoteState, showStopPage, stopPageIsOurs, viewOf } from './coordinator.js';
import { answeredOnPage, fillPage, unitArrival } from './fill.js';
import { syncAiBanner } from './assistant.js';
import { changeScopes, tabStep } from './scope.js';
import { currentReportKey, stopNoteFor } from './report-model.js';

// ---------------------------------------------------------------------------------------------
// Usage recording (see src/usage.js for what is and isn't kept)

// Progressive re-renders a page as "<Page>-Reload"; it's the same page.
const samePage = (p) => (p ?? '').replace(/-Reload$/, '');
// Progressive names its pages in ?pageName=; other sites by path or #/route (ids normalised).
const pageOf = (url) => {
  try {
    const u = new URL(url);
    const route = (u.pathname + (u.hash.startsWith('#/') ? u.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id');
    return samePage(u.searchParams.get('pageName') || route);
  } catch { return null; }
};

// Watch the rater tab while an intake is loaded. Only carrier pages; never other sites. Practice
// pages get it too (follow-up fills need it) but nothing from them goes in the usage log.
// A recorder already in the page is reused, and may still be paused by a fill the panel never
// finished (closed mid-fill): it is told to resume, unless a fill or AI apply is under way here.
async function ensureRecorder() {
  if (!inExtension || !state.intake || !state.tab?.carrier) return;
  const tabId = state.tab.id;
  // The developer recording's trace goes in with the recorder, whose readers it uses, into the tab
  // being recorded only (again after each page load).
  const trace = state.recording?.tabId === tabId && !state.recording.stopping ? ['src/content/trace.js'] : [];
  // The carrier's page adapter goes into the recorder's world too, first: how its fields are keyed
  // (field-key.js) and its pages drawn (the recorder) are its own. The kit's world gets its own copy
  // (injectKit): on Progressive that is the page's world, which this one can't see.
  const adapter = state.tab.carrier.pageAdapter ? [state.tab.carrier.pageAdapter] : [];
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [...adapter, 'src/content/field-key.js', 'src/content/recorder.js', ...trace] });
  } catch { return; /* page not ready or not allowed; tried again on the next tab update */ }
  if (!state.filling) await tellRecorder('resume', tabId);
}

function tellRecorder(cmd, tabId = state.tab?.id) {
  if (!Number.isInteger(tabId)) return Promise.resolve();
  return chrome.tabs.sendMessage(tabId, { ra: 'recorder', cmd }).catch(() => {});
}

function onRecorderMessage(msg, sender) {
  if (msg?.ra !== 'usage' || !state.intake || sender.tab?.id !== state.tab?.id) return;
  const carrier = state.tab.carrier?.id ?? null;
  const log = (...events) => { if (!state.tab.carrier?.practice) usage.log(...events); };
  // Layouts are of the quote page, the tab's top frame; a child frame names its own address.
  const layoutPage = sender.frameId ? pageOf(state.tab.url) : samePage(msg.page);
  if (msg.event === 'page_view') {
    if (msg.from) state.visitedPages.add(samePage(msg.from));
    // A new page since this intake was loaded, or the first page of a tab opened since (the quote
    // Progressive opens in a new tab): this tab's layouts may be taken again. A tab that was
    // already open and only now gets a recorder may still show the previous client's quote.
    if (msg.from ? samePage(msg.from) !== samePage(msg.page) : state.layoutNewTabs.has(sender.tab.id)) state.layoutReadyTabs.add(sender.tab.id);
    log({ type: 'page_view', carrier, page: msg.page, view: viewOf(sender.tab.id, samePage(msg.page)), from: msg.from, fields: msg.fields });
    // A new document: a stop screen (noteStopScreen) is read again from its arrival's layout.
    state.stopScreens?.delete(sender.tab.id);
    // Arriving at a carrier stop page (a new document, a reload, or a move from another page; not
    // its "-Reload" re-render): logged as a fill run that stopped, with the page name only, and
    // only once the tab is shown to be this intake's quote. A step that is the agent's (stopSteps)
    // is logged as the step arrives (noteStep), and its note shown here too.
    const stopPage = samePage(msg.page);
    if (stopNoteFor(state.tab.carrier, stopPage)) {
      if (state.tab.carrier.stopPages?.[stopPage] && (!msg.from || samePage(msg.from) !== stopPage) && stopPageIsOurs()) {
        log(...fillEvents([{ fields: 0, blockers: [`stop: ${stopPage}`] }], { carrier, page: stopPage, view: viewOf(sender.tab.id, stopPage), overwrite: false, auto: 'stop', ms: 0, redact: (text) => text }));
      }
      showStopPage();
    }
    if (!sender.frameId && state.tab.carrier?.quoteState) seedQuoteState(sender.tab.id, state.tab.carrier, samePage(msg.page));
    // Even with no fields in the top frame: a form may be all in child frames, which don't report
    // arrivals themselves.
    scheduleLayout(layoutPage, 'arrived');
    // Buttons that run again on every new arrival at their page (Print / Send: after the agent goes
    // back and changes something, coming back to print means printing the new quote).
    if (msg.from && samePage(msg.from) !== samePage(msg.page)) {
      for (const a of state.tab.carrier?.actions ?? []) {
        if (!a.repeatOnReturn || ![].concat(a.page ?? []).includes(samePage(msg.page))) continue;
        for (const id of [...state.doneActions]) if (id === a.id || id.startsWith(`${a.id}:`)) state.doneActions.delete(id);
        persistDoneActions();
      }
      if (state.tab.carrier?.trailerPage || state.tab.carrier?.driverPage || state.tab.carrier?.vehicleList) unitArrival(state.tab.carrier, samePage(msg.from), samePage(msg.page));
    }
    // Setting "Fill each new page as soon as it opens": fill right away (the fill itself waits
    // for the page to settle first).
    // Coming back to a page filled earlier in this quote (Rates after the bill plan) refills it
    // with the follow-up setting, so its next buttons (Recalculate, Print) run. Pages with only
    // buttons for us (Add Vehicle) count too.
    const page = samePage(msg.page);
    const hasButtons = (state.tab.carrier?.actions ?? []).some((a) => [].concat(a.page ?? []).includes(page));
    const wanted = $('auto-pages').checked || ($('auto-followups').checked && (state.autoPages.has(page) || (hasButtons && !msg.fields)));
    state.drawPending = null;
    if (wanted && (msg.fields > 0 || hasButtons) && onQuotePage()) {
      setTimeout(() => { if (pageOf(state.tab?.url) === samePage(msg.page)) fillPage({ auto: 'page' }); }, 100);
    } else if ($('auto-pages').checked && !msg.fields && onQuotePage()) {
      // Arrived before it drew a question (GEICO's first step: 6 of 8 quotes on 2026-10-26 waited
      // 3–127 s for the agent's Fill, W44-11): filled as on arriving, once they show (new_fields).
      state.drawPending = { tabId: sender.tab.id, page };
    }
    return;
  }
  if (msg.event === 'field_changes') {
    // The step the changes were made on, as the recorder read it with them: the panel's own word on
    // the tab's step can come a message late, and GEICO's Vehicles is scoped per vehicle.
    const step = knownStep(state.tab.carrier, msg.step);
    const ctx = { record: state.intake.record, filled: state.filled, labels: state.labels, choices: state.choices, redact: redactor(redactionTerms(state.intake.record)), keySalt: usage.currentSession()?.keySalt,
      step };
    const view = viewOf(sender.tab.id, samePage(msg.page));
    log(...msg.changes.map((c) => ({ carrier, page: msg.page, view, ...fieldChangeEvent(c, ctx) })));
    scheduleLayout(layoutPage, 'changed');
    // The quote's state, by whoever picked it: remembered for this tab, checked against the intake.
    for (const c of msg.changes) {
      const code = quoteStatePick(state.tab.carrier, samePage(msg.page), c);
      if (code !== undefined) noteQuoteState(sender.tab.id, carrier, code);
    }
    const byAgent = msg.changes.filter((c) => c.agent);
    if (byAgent.length) {
      const page = samePage(msg.page);
      if (noteChangedAfterDone(state.tab.carrier, page, step, sender.tab.id)) renderSteps();
      // On GEICO, by the unit forms on screen as the recorder saw them (changeScopes).
      for (const scope of changeScopes(page, state.tab.carrier, step, msg.forms)) {
        const keys = state.agentKeys.get(scope) ?? new Set();
        byAgent.forEach((c) => keys.add(c.key));
        state.agentKeys.set(scope, keys);
      }
      persistAgentKeys();
      // What the agent answered is no longer left for them in step 3 (an answer cleared still is),
      // and an answer the fill put in that they changed is theirs.
      answeredOnPage(page, byAgent.filter((c) => c.after !== ''));
      settleRejectedAi(page, byAgent, sender).then((released) => {
        if (released && state.tab?.id === sender.tab?.id && pageOf(state.tab?.url) === page) {
          syncAiBanner({ tabId: state.tab.id, page, carrier: state.tab.carrier });
          scheduleAutoFill(page);
        }
      }).catch(() => {});
      scheduleAutoFill(page);
    }
  }
  if (msg.event === 'new_fields') {
    const page = samePage(msg.page);
    // Questions drawn over a page already open (`fillOnDraw`, the addresses where it happens: GEICO's
    // Start New Quote window, over any gateway page) on a page no fill has answered anything on yet
    // (a gateway control drawn before the window is ignored): its first fill, as on arriving at a page.
    const firstFill = () => !state.autoPages.has(page) || !state.reports.get(currentReportKey())?.filled;
    // Or a page that arrived before it drew any (drawPending, W44-11).
    const drawnLate = state.drawPending?.tabId === sender.tab.id && state.drawPending.page === page;
    if ((state.tab.carrier?.fillOnDraw?.test(state.tab.url ?? '') || drawnLate) && $('auto-pages').checked && firstFill() && onQuotePage() && !stopNoteFor(state.tab.carrier, page)) {
      state.drawPending = null;
      setTimeout(() => { if (pageOf(state.tab?.url) === page) fillPage({ auto: 'page' }); }, 100);
    } else scheduleAutoFill(page, undefined, true);
    scheduleLayout(layoutPage, 'appeared');
  }
  if (msg.event === 'removed_fields') {
    scheduleLayout(layoutPage, 'removed');
    // A unit's form went away on a step with a unit list (GEICO's Next on a vehicle form, which
    // saves it and shows the list): the list draws no question, so no new_fields comes. With "Click
    // Continue when the page is done" on, a follow-up fill adds the next intake unit (FL live run 3,
    // 2026-10-21: nothing ran on the list until the agent clicked "+").
    const step = tabStep(state.tab.carrier);
    if (state.tab.carrier?.unitLists?.some((s) => s.steps.includes(step)) && $('auto-advance').checked) scheduleAutoFill(pageOf(state.tab.url));
  }
  // A unit list drawn, or its rows changed (the recorder's list_shown): GEICO draws the list 5–7 s
  // after the Next that saved a unit's form, after the follow-up above ran (FL live run 6,
  // 2026-10-21: nothing ran on the vehicle list until the agent clicked "+"). With "Fill the pages"
  // or "Click Continue when the page is done" on, as the "+" is clicked (pickUnitToAdd), a
  // follow-up fill adds the next intake unit.
  if (msg.event === 'list_shown') {
    const step = knownStep(state.tab.carrier, msg.step) ?? tabStep(state.tab.carrier);
    if (state.tab.carrier?.unitLists?.some((s) => s.steps.includes(step)) && ($('auto-advance').checked || $('auto-pages').checked)) scheduleAutoFill(pageOf(state.tab.url));
  }
  // A button the agent clicked themselves (its text, redacted): a helper or a Continue by hand.
  // On a one-address application, the step it was on (a known step name only, as elsewhere).
  if (msg.event === 'agent_click') {
    const page = samePage(msg.page);
    const step = state.tab.carrier?.layoutSteps ? knownStep(state.tab.carrier, msg.step) : undefined;
    log({ type: 'agent_click', carrier, page, view: viewOf(sender.tab.id, page), ...(step ? { step } : {}), text: redactor(redactionTerms(state.intake.record))(String(msg.text ?? '')).slice(0, 60) });
    agentHelperDone(state.tab.carrier, page, step, msg.text);
    // Only the Yes to GEICO's discard question: "Discard Changes" only asks it, and "No, please don't
    // discard." keeps the form, which would otherwise be filled as the next unit picked.
    if (/^\s*yes\b.*\bdiscard\b/i.test(String(msg.text ?? '')) && Array.isArray(msg.forms)) releaseDiscardedForms(msg.forms);
  }
  // An error or validation message appeared (a refused Continue): the layout carries the messages.
  if (msg.event === 'new_messages') scheduleLayout(layoutPage, 'messages');
}

// A helper the agent clicked themselves is done, as one a fill clicked: a later fill doesn't click
// it again (live recording, 2026-10-23: the agent's View bill plan options, then the fill's on the
// way back, so the payment plan page came up twice). Matched as the kit matches a helper (its
// words, on its page or step), and only a quote-wide one: a vehicle's, driver's or trailer's has
// markers of its own, and an Add Vehicle by hand may be another unit's. Not one its words alone don't
// name (`near`, `token`, `within`, `opener`, `unique`: Progressive's cargo and general liability
// "+" read the same), nor one that recalculates (needsRecalculation): whether that is due again
// follows the rates on the page. Nor one the fill checks after its click (`verify`: cargo's and
// general liability's Done with this coverage): on a quote asking for only one of them, the agent's
// Done may be another coverage's, or one Progressive refused, and a fill's own counts only once the
// check passes.
function agentHelperDone(carrier, page, step, text) {
  const words = String(text ?? '').trim();
  if (!carrier?.actions?.length || !state.intake?.record || !words || words.length > 80) return;
  let plan;
  try { plan = buildPlan(state.intake.record, carrier, state.active); } catch { return; }
  const done = plan.filter((s) => s.kind === 'action' && s.action === s.baseAction && !s.needsRecalculation && !s.verify && s.text
    && !s.near && !s.token && !s.within && !s.opener && !s.unique
    && (!s.pages?.length || s.pages.includes(page)) && (!s.steps?.length || (!!step && s.steps.includes(step)))
    && new RegExp(s.text, 'i').test(words));
  // Two helpers reading the same (cargo's and general liability's Done with this coverage): the words
  // can't say which was clicked, so neither is done.
  if (done.length !== 1) return;
  const id = done[0].action;
  const doneBefore = state.doneActions.has(id) && !state.doneActions.has(`${id}:changed`);
  state.doneActions.add(id);
  // The quote's finishing action clicked again (Print Quote Proposal after the agent's Recalculate):
  // the proposal is the quote on the page again (noteChangedAfterDone).
  const lifted = state.doneActions.delete(`${id}:changed`);
  persistDoneActions();
  if (lifted) renderSteps();
  // The agent's own click of the finishing action (GEICO's Print Quote Proposal after their own
  // Recalculate): the quote is done, with its chime (noteQuoteDone). Not one done before and not
  // changed since: the same quote printed again.
  if (id === carrier.finishedBy && !doneBefore) noteQuoteDone();
}

export { ensureRecorder, onRecorderMessage, pageOf, samePage, tellRecorder };
