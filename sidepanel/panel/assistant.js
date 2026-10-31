// The side panel: the Luna assistant.
// One part of the panel; sidepanel.js wires the parts together.
import { ntlMention, ntlCheckMessage, intakeNotes, nonTruckingAnswer, ntlWithCargo, NTL_CARGO_MESSAGE, NTL_FORM_MESSAGE, ntlWithPrimary, NTL_PRIMARY_MESSAGE } from '../../src/normalize.js';
import { redactionTerms } from '../../src/plan.js';
import { get } from '../../src/util.js';
import { redactor } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { collectItems, AssistError, assistContextKey, stableJson, pageAnswers } from '../../src/ai/common.js';
import { claimsTruncated, firstNameOf } from '../../src/ai/luna.js';
import { PROVIDERS, settingsFrom, suggest, reviewNotes, reviewDriverNames } from '../../src/ai/providers.js';
import { $, aiActionCurrent, aiAnswerOrigin, aiCacheSignature, aiCurrentAnswerPresent, aiDecisionBlocks, aiFingerprint, aiItemFingerprint, aiLiveFieldHash, aiOriginRecord, aiQuestionHash, aiRetiredSignatures, aiSafeText, aiSettledOnPage, aiSnapshotFieldMatches, h, persistAiPending, persistGuardedEdits, snapshotFingerprint, snapshotHashMatches, snapshotsEqual, state } from './core.js';
import { logSettings, save } from './intake.js';
import { agentEdit, openKeyForm, openSettings, render, renderSections, toggleDone } from './record.js';
import { pageOf, tellRecorder } from './usage.js';
import { announce, noteChangedAfterDone, recount, renderSteps, scheduleAutoFill, scheduleLayout } from './coordinator.js';
import { fillPage, runKit, setRowHead } from './fill.js';
import { renderUsage } from './usage-panel.js';
import { agentEdited, editScope, tabStep } from './scope.js';
import { choiceSaid } from './report-model.js';

// ---------------------------------------------------------------------------------------------
// Luna assistant: after a fill, suggests answers for the questions left for the agent.
// Verified choices can be applied automatically, but Continue waits for explicit agent review.

async function aiSettings() {
  return settingsFrom(await usage.settings(), await usage.serverConfig());
}

// Luna reads the claims box once per intake (reviewNotes in src/ai/luna.js): lines that may name
// non-trucking liability, ask for a coverage change or say how long the business has run (when
// that differs from the intake) become Intake check items, and the tab
// count goes up (the panel doesn't switch steps under the agent). Flags only; the agent decides.
// Logged as counts, never the text. A review that failed says so on the Intake step and is tried
// again when the assistant settings change (`retry`), not on every panel reload. What it read
// (the claims box and the form's coverages) must still be the intake's when Luna answers;
// otherwise the answer is dropped and the box read again.
// Luna's claims-box items for a text the agent has since edited become info notes, in place
// (warnings are marked checked by position).
// The claims box text changed: the intake's own NTL item follows it (updated, re-asked, or retired
// when NTL is no longer mentioned), and a checked long-box or failed-review item is asked again,
// since its check was for the old text. Items are kept by position (checked marks are).
function claimsTextEdited(intake) {
  const uncheck = (i) => { intake.done = intake.done.filter((d) => d !== i); };
  ntlNotesItem(intake);
  intake.warnings.forEach((w, j) => { if (['ai.claims-truncated', 'ai.claims-review-failed'].includes(w.code)) uncheck(j); });
  save();
  render();
}

// The intake's NTL item about the notes (coverage.ntl) for the notes and auto liability as they are
// now: asked (again, unchecked, for a new line), or retired to a note when the notes no longer name
// NTL or the form asks for it (auto liability Non-Trucking).
function ntlNotesItem(intake) {
  const fromForm = intake.record.coverage?.ntl === true && nonTruckingAnswer(intake.record.coverage.autoLiability);
  const mention = fromForm ? null : ntlMention(intakeNotes(intake.record));
  const i = intake.warnings.findIndex((w) => w.code === 'coverage.ntl');
  if (mention && i < 0) intake.warnings.push({ code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) });
  else if (mention && (intake.warnings[i].msg !== ntlCheckMessage(mention) || intake.warnings[i].level !== 'check')) {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: ntlCheckMessage(mention) };
    intake.done = intake.done.filter((d) => d !== i);
  } else if (!mention && i >= 0 && intake.warnings[i].level === 'check') {
    intake.warnings[i] = { code: 'coverage.ntl', path: 'coverage.ntl', level: 'info', msg: fromForm
      ? 'Non-trucking liability is asked for on the form (auto liability Non-Trucking): the notes need no answer about it.'
      : 'The claims box and Additional Notes no longer mention non-trucking liability (NTL).' };
  }
}

// The agent's edit of auto liability (which sets NTL: rederive) or of NTL itself: the form's NTL
// note follows it (back, or retired when NTL is no longer the form's Non-Trucking), and after an
// auto liability edit the notes' NTL item too (an NTL the form no longer asks for is asked about
// again). An NTL the agent set themselves asks nothing more about the notes. Kept by position.
function ntlAnswerEdited(intake, path) {
  const fromForm = intake.record.coverage?.ntl === true && nonTruckingAnswer(intake.record.coverage.autoLiability);
  const f = intake.warnings.findIndex((w) => w.code === 'coverage.ntl-form');
  const formNote = { code: 'coverage.ntl-form', path: 'coverage.ntl', level: 'info', msg: NTL_FORM_MESSAGE };
  if (fromForm && f < 0) intake.warnings.push(formNote);
  else if (fromForm) intake.warnings[f] = formNote;
  else if (f >= 0 && intake.warnings[f].msg === NTL_FORM_MESSAGE) {
    intake.warnings[f] = { ...formNote, msg: 'Auto liability is no longer Non-Trucking with Non-trucking liability Yes: Non-trucking liability is as the client details have it.' };
  }
  if (path === 'coverage.autoLiability') ntlNotesItem(intake);
}

// NTL and cargo both Yes after the agent's edit of either (or of auto liability, which sets NTL):
// the intake's check is asked (again, unchecked, when it was retired), or retired to a note when
// they no longer are. Kept by position, as the checked marks are.
function ntlCargoEdited(intake) {
  const both = ntlWithCargo(intake.record);
  const i = intake.warnings.findIndex((w) => w.code === 'coverage.ntl-cargo');
  const ask = { code: 'coverage.ntl-cargo', path: 'coverage.cargo', level: 'check', msg: NTL_CARGO_MESSAGE };
  if (both && i < 0) intake.warnings.push(ask);
  else if (both && intake.warnings[i].level !== 'check') {
    intake.warnings[i] = ask;
    intake.done = intake.done.filter((d) => d !== i);
  } else if (!both && i >= 0 && intake.warnings[i].level === 'check') {
    intake.warnings[i] = { code: 'coverage.ntl-cargo', path: 'coverage.cargo', level: 'info', msg: 'Non-trucking liability and cargo coverage are no longer both asked for.' };
  }
}

// NTL and primary auto liability (auto liability Yes) both asked for after the agent's edit of either
// (TNI, 2026-10-26: answer to PR question): the intake's check naming the conflict is asked (again,
// unchecked, when it was retired), or retired to a note when they no longer are. Today's form can't
// ask for both (Non-Trucking is its auto liability answer), so the agent's NTL Yes with auto
// liability Yes is where it arises. Kept by position, as the checked marks are.
function ntlPrimaryEdited(intake) {
  const both = ntlWithPrimary(intake.record);
  const i = intake.warnings.findIndex((w) => w.code === 'coverage.ntl-primary');
  const ask = { code: 'coverage.ntl-primary', path: 'coverage.autoLiability', level: 'check', msg: NTL_PRIMARY_MESSAGE };
  if (both && i < 0) intake.warnings.push(ask);
  else if (both && intake.warnings[i].level !== 'check') {
    intake.warnings[i] = ask;
    intake.done = intake.done.filter((d) => d !== i);
  } else if (!both && i >= 0 && intake.warnings[i].level === 'check') {
    intake.warnings[i] = { code: 'coverage.ntl-primary', path: 'coverage.autoLiability', level: 'info', msg: 'Non-trucking liability and primary auto liability are no longer both asked for.' };
  }
}

// The long-claims-box item is the code's own: it stays while the box is still too long to read whole.
function supersedeClaimsItems(intake) {
  const truncated = claimsTruncated(intakeNotes(intake.record));
  intake.warnings.forEach((w, i) => {
    if (['ai.ntl', 'ai.coverage-change', 'ai.years-in-business', 'ai.gl'].includes(w.code) ||(w.code === 'ai.claims-truncated' && !truncated)) {
      if (w.code === 'ai.ntl' && intake.record.claims) intake.record.claims.aiNtl = false;
      intake.warnings[i] = { code: 'ai.claims-superseded', path: w.path, level: 'info', msg: `Earlier Luna item, for a claims box or Additional Notes since edited: ${w.msg}` };
    }
  });
}

function claimsContext(record) {
  // NTL and GL (asked for or had) are not sent as form coverage (Luna's own questions): setting
  // them isn't a change.
  const { ntl, gl, hasGl, ...coverage } = record.coverage ?? {};
  // In key order (stableJson): otherwise every reopen took the saved intake for an edit, Luna's
  // claims-box items were retired, the box was sent again, and the intake saved over any change
  // made meanwhile.
  // The Additional Notes box only when the intake has it: an older saved intake keeps its context.
  return stableJson([record.claims?.text ?? null, coverage, ...(record.notes?.text ? [record.notes.text] : [])]);
}

async function reviewClaimsBox({ retry = false } = {}) {
  const intake = state.intake;
  // A finished review stands while what it read is unchanged (older records didn't keep that).
  // Once the agent has edited it, Luna's items for the old text are retired right away, whether or
  // not a new review can run now (assistant off, no key, a failure).
  if (intake?.notesReview?.done && intake.notesReview.context != null && intake.notesReview.context !== claimsContext(intake.record)) {
    supersedeClaimsItems(intake);
    intake.notesReview = null;
    await save();
    render();
  }
  if (!intakeNotes(intake?.record) || intake.notesReview?.done || (intake.notesReview?.failed && !retry)) return;
  // One at a time: a settings change during a review runs once it ends (a corrected key).
  if (state.notesAsking === intake) { if (retry) state.notesRetry = intake; return; }
  // Taken before the first await: two triggers close together ask once.
  state.notesAsking = intake;
  let again = false;
  try {
    const cfg = await aiSettings();
    if (!cfg.on || !cfg.ready || state.intake !== intake) return;
    const started = Date.now();
    const read = claimsContext(intake.record);
    const logged = { type: 'ai_suggest', page: 'ClaimsBox', model: cfg.model };
    const failed = intake.warnings.findIndex((w) => w.code === 'ai.claims-review-failed');
    try {
      const result = await reviewNotes(intake.record, cfg, { redact: redactor(redactionTerms(intake.record)) });
      // Nothing about a replaced intake is logged under the new one.
      if (state.intake !== intake) return;
      const changed = claimsContext(intake.record) !== read;
      usage.log({ ...logged, ms: Date.now() - started, items: result.lines, suggested: result.flagged, leave: result.lines - result.flagged,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls, reasoningTokens: result.reasoningTokens,
        cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens, ...(changed ? { error: 'Answer discarded: the claims box or coverages changed.' } : {}) });
      if (changed) { again = true; return; }
      // Warnings are marked checked by position: an earlier failure, or Luna's items from a claims
      // box the agent has since edited, are replaced in place, never removed.
      if (failed >= 0) intake.warnings[failed] = { code: 'ai.claims-reviewed', path: 'claims.text', level: 'info', msg: 'Luna reviewed the claims box and Additional Notes after an earlier failure.' };
      supersedeClaimsItems(intake);
      // One long-claims-box item, kept from an earlier review.
      const kept = intake.warnings.some((w) => w.code === 'ai.claims-truncated');
      intake.warnings.push(...result.warnings.filter((w) => !(kept && w.code === 'ai.claims-truncated')));
      // Luna's NTL flag holds Progressive's Rates until the agent answers it, like an NTL mention.
      if (result.warnings.some((w) => w.code === 'ai.ntl') && intake.record.claims) intake.record.claims.aiNtl = true;
      intake.notesReview = { done: true, model: cfg.model, flagged: result.warnings.length, context: read };
    } catch (e) {
      if (state.intake !== intake) return;
      const msg = e instanceof AssistError ? e.message : 'The claims-box review failed.';
      usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (failed < 0) intake.warnings.push({ code: 'ai.claims-review-failed', path: 'claims.text', level: 'check', msg: "Luna couldn't review the claims box and Additional Notes. Read them for coverage requests, e.g. NTL or a different limit." });
      intake.notesReview = { failed: true, model: cfg.model };
    }
    await save();
    render();
  } finally {
    if (state.notesAsking === intake) state.notesAsking = null;
    const queued = state.notesRetry === intake;
    if (queued) state.notesRetry = null;
    if ((again || queued) && state.intake === intake) reviewClaimsBox({ retry: true });
  }
}

// Driver gender is filled MALE (TNI standard) unless drivers[i].gender is set. Once per intake,
// with the assistant on, Luna is asked whether each such driver's first name is more often a
// woman's (reviewDriverNames in src/ai/luna.js: only the first names are sent, nothing else).
// likely_female becomes an Intake check item with Use Female / Keep Male (applyCheckChoice: the
// agent's edit). A failure is an info note: the TNI standard stands. What it read (the drivers'
// first names) must still be the intake's when Luna answers; an edit to a first name afterwards
// retires its items (info notes, in place) and reads the names again. Logged as counts only.
function driverNamesContext(record) {
  return JSON.stringify((record.drivers ?? []).map((d) => firstNameOf(d?.first)));
}

function supersedeGenderItems(intake) {
  intake.warnings.forEach((w, i) => {
    if (w.code === 'ai.driver-gender') intake.warnings[i] = { code: 'ai.driver-gender-superseded', path: w.path, level: 'info', msg: `Earlier Luna item, for a driver name since edited: ${w.msg}` };
  });
}

async function reviewDriverGender({ retry = false } = {}) {
  const intake = state.intake;
  if (intake?.namesReview?.done && intake.namesReview.context !== driverNamesContext(intake.record)) {
    supersedeGenderItems(intake);
    intake.namesReview = null;
    await save();
    render();
  }
  if (!intake?.record.drivers?.length || intake.namesReview?.done || (intake.namesReview?.failed && !retry)) return;
  if (state.namesAsking === intake) { if (retry) state.namesRetry = intake; return; }
  state.namesAsking = intake;
  let again = false;
  try {
    const cfg = await aiSettings();
    if (!cfg.on || !cfg.ready || state.intake !== intake) return;
    const started = Date.now();
    const read = driverNamesContext(intake.record);
    const logged = { type: 'ai_suggest', page: 'DriverNames', model: cfg.model };
    const failed = intake.warnings.findIndex((w) => w.code === 'ai.driver-names-failed');
    try {
      const result = await reviewDriverNames(intake.record, cfg);
      if (state.intake !== intake) return;
      const changed = driverNamesContext(intake.record) !== read;
      if (result.modelCalls) {
        usage.log({ ...logged, ms: Date.now() - started, items: result.names, suggested: result.flagged, leave: result.names - result.flagged,
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls, reasoningTokens: result.reasoningTokens,
          cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens, ...(changed ? { error: 'Answer discarded: a driver name changed.' } : {}) });
      }
      if (changed) { again = true; return; }
      if (failed >= 0) intake.warnings[failed] = { code: 'ai.driver-names-reviewed', path: 'drivers', level: 'info', msg: 'Luna checked the drivers\' first names after an earlier failure.' };
      // A driver whose gender the agent set meanwhile keeps it: no item for them.
      intake.warnings.push(...result.warnings.filter((w) => !get(intake.record, w.path)));
      intake.namesReview = { done: true, model: cfg.model, flagged: result.flagged, context: read };
    } catch (e) {
      if (state.intake !== intake) return;
      const msg = e instanceof AssistError ? e.message : 'The driver-name check failed.';
      usage.log({ ...logged, ms: Date.now() - started, error: msg.slice(0, 200) });
      if (failed < 0) intake.warnings.push({ code: 'ai.driver-names-failed', path: 'drivers', level: 'info', msg: "Luna couldn't check the drivers' first names. Gender is filled Male (TNI standard) unless you set it under All client details." });
      intake.namesReview = { failed: true, model: cfg.model };
    }
    await save();
    render();
  } finally {
    if (state.namesAsking === intake) state.namesAsking = null;
    const queued = state.namesRetry === intake;
    if (queued) state.namesRetry = null;
    if ((again || queued) && state.intake === intake) reviewDriverGender({ retry: true });
  }
}

// Luna's reviews of a loaded intake: the claims box, and drivers' first names.
function reviewIntake(opts) {
  reviewClaimsBox(opts);
  reviewDriverGender(opts);
}

// A check card's own buttons (Luna's GL and driver-gender items): set the field as the agent's
// edit, then mark the item checked. Only these fields and values: the item is stored data.
const CHOICE_FIELDS = [[/^coverage\.hasGl$/, [true]], [/^drivers\[\d+\]\.gender$/, ['FEMALE', 'MALE']]];
async function applyCheckChoice(i, choice) {
  const w = state.intake?.warnings[i];
  if (!w || !w.choices?.some((c) => c.label === choice.label && c.path === choice.path && c.value === choice.value)) return;
  if (choice.path !== undefined) {
    const allowed = choice.path === w.path && CHOICE_FIELDS.some(([re, values]) => re.test(choice.path) && values.includes(choice.value));
    if (!allowed) return;
    if (get(state.intake.record, choice.path) !== choice.value) {
      // Changed before anything awaits, like an edit in All client details.
      const editing = agentEdit(choice.path, choice.value, typeof choice.value === 'boolean' ? 'bool' : 'text');
      renderSections();
      await editing;
    }
  }
  // Logged as the edit (intake_edit, no value) and the check (warning_checked).
  await toggleDone(i, true);
}

// ctx: { tabId, page, carrier } of the fill these frames came from.
async function runAssist(frames, ctx) {
  const record = state.intake?.record;
  const active = { ...state.active };
  ctx = { ...ctx, intake: state.intake, tabUrl: state.tab?.url, contextKey: assistContextKey(record, active) };
  const cfg = await aiSettings();
  if (!cfg.on || !record || !aiActionCurrent(ctx, []) || ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return;
  const provider = PROVIDERS[cfg.provider];
  // Questions the agent (or an applied AI answer) already settled on this page are not asked again.
  const collected = collectItems(frames);
  const items = collected.items.filter(x => !agentEdited(ctx.page, x.key) && !aiSettledOnPage(ctx.tabId, ctx.page, x));
  const blocked = collected.blocked;
  // Messages, the approval card and suggestions without a list item go above "Needs you".
  const holder = h('div', { class: 'ai-holder' });
  const head = $('report').querySelector('.needs-head');
  if (!items.length) {
    // Nothing new to ask, but AI picks still waiting for approval keep their card.
    if (pendingAi(ctx.tabId, ctx.page).length) {
      if (head) head.before(holder); else $('report').append(holder);
      renderAi(holder, [], ctx);
    }
    return;
  }
  if (head) head.before(holder); else $('report').append(holder);
  if (!cfg.ready) {
    holder.append(h('p', { class: 'note-line' }, `${provider.name} needs an ${provider.keyLabel}. `,
      h('button', { type: 'button', class: 'link small', onclick: () => openSettings('ai-openai-key') }, 'Add the key')));
    return;
  }
  const run = ++state.aiRun;
  ctx.run = run;
  try {
    ctx.snapshots = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null));
  } catch { return; }
  // Why this request's answer can't be used at all: its settings, tab, page, intake or
  // driver/vehicle are no longer the panel's. Null while they are.
  const discardWhy = () => (run < state.aiSettingsRun ? 'the assistant settings changed'
    : !aiActionCurrent(ctx, []) ? 'the tab or page changed'
    : ctx.contextKey !== assistContextKey(state.intake?.record, state.active) ? 'the intake or driver/vehicle changed' : null);
  // Why this request (or its answer) no longer fits what the panel shows; null while it does. A
  // newer request or a redrawn report alone doesn't make the answer wrong: it is cached, and the
  // newer request waits for it (2026-10-09 to 10-26: 12 of 58 page reviews were thrown away, most
  // on GEICO's quote page while a fill of the same page redrew it).
  const staleWhy = () => discardWhy() ?? (run !== state.aiRun ? 'a newer request'
    : !holder.isConnected ? 'the panel was redrawn' : null);
  const stale = () => !!staleWhy();
  // A dropped answer never leaves "Asking…" on screen (2026-10-05 FL run: Luna answered in 17 s,
  // the panel kept waiting for minutes).
  // Also in a report kept while another tab or step is in front: it says so when that one is back.
  const dropped = (what, next = 'Click Fill this page to ask again.') => {
    if (run !== state.aiRun) { holder.remove(); return; }
    holder.replaceChildren(h('p', { class: 'card bad small' }, `${provider.name}: ${what}. ${next}`));
  };
  // Reuse an answer for the same question (as the page shows it now) in the same intake and
  // driver/vehicle, model and policy. Not keyed on the rest of the page: every automatic
  // follow-up fill changes that, which asked the assistant again each time. Putting an answer in still
  // checks the page snapshot (applyAi), and approving checks it again.
  const contextHash = aiFingerprint(ctx.contextKey);
  const sigOf = x => aiCacheSignature({ tabId: ctx.tabId, page: ctx.page, model: cfg.model, policy: provider.policy, contextHash, itemHash: aiItemFingerprint(x), quoteHash: aiFingerprint(ctx.tabUrl) });
  const asking = (n) => holder.replaceChildren(h('p', { class: 'ai-wait' }, `Asking ${provider.name} about ${n} question${n === 1 ? '' : 's'} left for you…`));
  // Questions an earlier request is still asking (same signature: this page as it shows them now)
  // are waited for, not asked again: its answer is cached when it comes.
  const earlier = [...new Set(items.map((x) => state.aiAsking.get(sigOf(x))).filter(Boolean))];
  if (earlier.length) {
    asking(items.filter((x) => !state.aiCache.has(sigOf(x))).length);
    await Promise.all(earlier);
    if (stale()) { dropped(`${staleWhy()} while it was answering, so nothing was applied`); return; }
  }
  const missing = items.filter((x) => !state.aiCache.has(sigOf(x)));
  if (missing.length) {
    asking(missing.length);
    const started = Date.now();
    // The page's other choice questions and their answers go along as context (redacted, bounded,
    // never typed values): what the agent sees beside the questions left to them.
    const context = { record, carrier: ctx.carrier.id, page: ctx.page, active, pageAnswers: pageAnswers(ctx.snapshots, missing, record) };
    const logged = { type: 'ai_suggest', carrier: ctx.carrier.id, page: ctx.page, model: cfg.model, items: missing.length, blocked: blocked.length };
    let answered = () => {};
    const sigs = missing.map(sigOf);
    const pending = new Promise((resolve) => { answered = resolve; });
    sigs.forEach((sig) => state.aiAsking.set(sig, pending));
    try {
      // Stopped between model calls only for an answer that would be discarded.
      const result = await suggest(missing, context, cfg, { isStale: () => !!discardWhy() });
      const fresh = result.suggestions;
      // An answer that came too late is still logged (its tokens were spent), with the reason.
      const why = discardWhy();
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, suggested: fresh.filter(x => !x.leave).length,
        leave: fresh.filter(x => x.leave).length, autoOk: fresh.filter(x => x.autoOk).length, ...leaveCounts(fresh),
        tokensIn: result.tokensIn, tokensOut: result.tokensOut, modelCalls: result.modelCalls,
        reasoningTokens: result.reasoningTokens, cachedTokens: result.cachedTokens, cacheWriteTokens: result.cacheWriteTokens,
        ...(why ? { error: `Answer discarded: ${why}.` } : {}) });
      if (why) { dropped(`it answered after ${why}, so nothing was applied`); return; }
      fresh.forEach(x => state.aiCache.set(sigOf(x), {
        ...x, policy: provider.policy, contextKey: ctx.contextKey, contextHash, itemHash: aiItemFingerprint(x), quoteHash: aiFingerprint(ctx.tabUrl),
      }));
    } catch (e) {
      const msg = e instanceof AssistError ? e.message : 'The assistant could not review this page. Nothing was applied.';
      if (!ctx.carrier.practice) usage.log({ ...logged, ms: Date.now() - started, error: redactor(redactionTerms(record))(msg).slice(0, 200) });
      if (!stale()) holder.replaceChildren(h('p', { class: 'card bad small' }, `AI assistant: ${msg}`));
      else dropped(`${staleWhy()} while it was answering, so nothing was applied`);
      return;
    } finally {
      sigs.forEach((sig) => { if (state.aiAsking.get(sig) === pending) state.aiAsking.delete(sig); });
      answered();
    }
  }
  const suggestions = items.map((x) => state.aiCache.get(sigOf(x))).filter(Boolean);
  if (stale()) { dropped(`${staleWhy()} before its answers were shown, so nothing was applied`); return; }
  let applied = false;
  if (cfg.auto) {
    const picks = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
    // Anything sent to the page counts, also an answer that couldn't be confirmed.
    if (picks.length) { await applyAi(picks, ctx, 'auto'); applied = picks.some((x) => x.done); }
  }
  if (!stale()) renderAi(holder, suggestions, ctx);
  else if (applied) dropped(`${staleWhy()} after its selections were put in`, 'Click Fill this page to review them before continuing.');
  else dropped(`${staleWhy()} before its answers were shown, so nothing was applied`);
  syncAiBanner(ctx);
}

// Why Luna left questions, as counts (luna.js leaveWhy): it said information is missing, saw a
// conflict, chose to leave, cited nothing usable, or its answer failed the evidence check.
function leaveCounts(suggestions) {
  const field = { missing: 'leaveMissing', conflict: 'leaveConflict', chose: 'leaveChose', noSource: 'leaveNoSource', unverified: 'leaveUnverified' };
  const out = Object.fromEntries(Object.values(field).map((k) => [k, 0]));
  for (const x of suggestions) if (x.leave && field[x.leaveWhy]) out[field[x.leaveWhy]]++;
  return out;
}

// AI selections on this tab's page that the agent hasn't approved or rejected yet. While there
// are any, the page's Continue is never clicked automatically. Picks made before the agent
// changed the intake or the driver/vehicle are included: they're still on the page, unapproved,
// so they keep blocking until the agent approves or rejects them (the card always offers both).
function pendingAi(tabId, page) {
  const out = [];
  for (const [sig, x] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(tabId) && p === page && aiDecisionBlocks(x)
      && (!x.quoteHash || x.quoteHash === aiFingerprint(state.tab?.url))) out.push(x);
  }
  return out;
}

// A new fill clears the page's marks: put the purple back on the AI's answers on this page.
async function remarkAi(ctx) {
  const answered = [];
  const contextHash = aiFingerprint(assistContextKey(state.intake?.record, state.active));
  for (const [sig, x] of state.aiCache) {
    const [t, p] = sig.split('\n');
    if (t === String(ctx.tabId) && p === ctx.page && x.done && !x.rejected
      && (x.contextKey === assistContextKey(state.intake?.record, state.active) || x.contextHash === contextHash)) answered.push(x);
  }
  if (!answered.length) return;
  try {
    await runKit(ctx.tabId, ctx.carrier, (list) => list.forEach(([k, l, n]) => globalThis.__raterKit.markKey(k, l, 'ai', n)),
      [answered.map((x) => [x.key, x.label, x.done === 'auto' && !x.approved ? 'selected by the AI: approve it in the side panel' : 'AI answer'])]);
  } catch { /* page navigating */ }
  await syncAiBanner(ctx);
}

// The note at the bottom of the rater page listing the selections waiting for approval.
async function syncAiBanner(ctx) {
  if (state.tab?.id !== ctx.tabId) return;
  const lines = pendingAi(ctx.tabId, ctx.page).map((x) => `${x.label}: ${x.choice}`);
  try { await runKit(ctx.tabId, ctx.carrier, (l) => globalThis.__raterKit.aiBanner(l), [lines]); } catch { /* page navigating */ }
}

// Puts AI answers into the page through the fill engine, which checks the page kept each one.
// decision: 'accepted' (the agent clicked Accept) or 'auto' (the auto-select setting).
async function applyAi(list, ctx, decision) {
  if (state.filling || state.closing) return false;
  if (state.tab?.id !== ctx.tabId || pageOf(state.tab?.url) !== ctx.page) return false;
  if (ctx.contextKey !== assistContextKey(state.intake?.record, state.active)) return false;
  if (ctx.run !== undefined && ctx.run !== state.aiRun) return false;
  list = list.filter(x => ['radio', 'select', 'checkbox'].includes(x.controlKind) && !x.leave && !agentEdited(ctx.page, x.key) && (decision !== 'auto' || x.autoOk));
  if (!list.length || !aiActionCurrent(ctx, list)) return false;
  const isCurrent = () => aiActionCurrent(ctx, list)
    && ctx.contextKey === assistContextKey(state.intake?.record, state.active)
    && (ctx.run === undefined || ctx.run === state.aiRun);
  const entries = [...state.aiCache].filter(([, x]) => list.includes(x));
  const editOrigin = { scope: usage.currentSession()?.intakeId, tabId: ctx.tabId,
    page: editScope(ctx.page, ctx.carrier), keys: state.agentKeys, epoch: state.agentKeysEpochs?.get(usage.currentSession()?.intakeId) ?? 0 };
  let dispatched = false, prepared = false, guarding = false;
  const guardToken = crypto.randomUUID();
  state.filling = true;
  await tellRecorder('pause', ctx.tabId);
  try {
    if (!isCurrent()) return false;
    // Watch every frame before the snapshot and pending-hold writes. An idle frame stays
    // guarded while another waits on its server, until the full apply finishes.
    guarding = true;
    await runKit(ctx.tabId, ctx.carrier, (t) => globalThis.__raterKit.answerEdits('begin', t), [guardToken]);
    if (!isCurrent()) return false;
    const current = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null));
    if (!isCurrent()) return false;
    if (!snapshotsEqual(current, ctx.snapshots)) {
      for (const x of list) x.error = 'the page changed; click Fill this page for fresh suggestions';
      return false;
    }
    list = list.filter(x => {
      if (aiSnapshotFieldMatches(current, x).length === 1) return true;
      x.error = 'the question is ambiguous across page frames; answer it on the page';
      return false;
    });
    if (!list.length) return false;
    const answers = list.map((x) => ({
      key: x.key, label: x.label, value: x.choice,
      expected: { kind: x.controlKind, section: x.section, options: x.options, current: x.current },
      note: `${decision === 'auto' ? 'selected by the AI' : 'AI suggestion you accepted'}: ${x.tip}`.slice(0, 240),
    }));
    // Persist a conservative hold before dispatch. The carrier can change a field before answer()
    // returns, so replacing the intake or clearing a cache must never erase that operation.
    prepared = true;
    for (const x of list) {
      const [{ frame }] = aiSnapshotFieldMatches(current, x);
      x.pendingScope = usage.currentSession()?.intakeId ?? `pending:${aiFingerprint(ctx.contextKey)}`;
      x.pendingLabel = aiSafeText(x.label);
      x.pendingChoice = aiSafeText(x.choice);
      x.quoteHash = aiFingerprint(ctx.tabUrl);
      x.origin = aiAnswerOrigin(current, x, { ...frame, shown: x.choice });
      x.originAmbiguous = !x.origin;
      x.fieldHash = x.origin?.fieldHash ?? null;
      x.snapshots = current;
      x.snapshotHash = snapshotFingerprint(current);
      x.done = 'auto';
    }
    await persistAiPending();
    if (!isCurrent()) return false;
    // One answer at a time lets an edit in any frame stop every answer still to come,
    // including later answers in the active frame.
    const results = [];
    const readEdits = async (command = 'read') => {
      const frames = await runKit(ctx.tabId, ctx.carrier, (c, t) => globalThis.__raterKit.answerEdits(c, t), [command, guardToken]);
      for (const frame of frames) for (const item of frame.result ?? []) {
        if (item?.protected) results.push({ ...item, frameId: frame.frameId, documentId: frame.documentId });
      }
      if (current.some(origin => !frames.some(frame => frame.frameId === origin.frameId
        && frame.documentId === origin.documentId && Array.isArray(frame.result)))) {
        return 'the page or frame changed while applying the answers; request fresh suggestions';
      }
      return results.some(r => r.protected)
        ? 'an agent edit interrupted applying the answers; review the page, then request fresh suggestions' : null;
    };
    const startedFrames = new Set();
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      const interruption = await readEdits();
      if (interruption || !isCurrent()) {
        results.push({ key: a.key, label: a.label, ok: false, reason: interruption
          ?? 'the intake or page context changed; request fresh suggestions' });
        continue;
      }
      const frameId = aiSnapshotFieldMatches(current, list[i])[0].frame.frameId;
      const expected = startedFrames.has(frameId) ? null : ctx.snapshots.map(r => r.result);
      startedFrames.add(frameId);
      dispatched = true;
      // The carrier's stop steps go along: after a reload no fill has told this document about them.
      const answerFrames = await runKit(ctx.tabId, ctx.carrier, (a, snapshots, t, o) => globalThis.__raterKit.answer(a, snapshots, t, o),
        [[a], expected, guardToken, { stopSteps: Object.keys(ctx.carrier.stopSteps ?? {}) }], [frameId]);
      for (const frame of answerFrames) for (const item of frame.result ?? []) {
        if (item && typeof item === 'object') results.push({ ...item, frameId: frame.frameId, documentId: frame.documentId });
      }
    }
    await readEdits('end');
    guarding = false;
    const sameContext = isCurrent();
    const keys = sameContext ? state.agentKeys.get(editOrigin.page) ?? new Set() : null;
    // The agent's own edits while the answers went in (also on a control the carrier redrew, which
    // the recorder cannot match on resume): a later fill keeps them, as after a fill.
    const protectedKeys = results.filter(r => r.protected).map(r => r.key);
    for (const x of list) {
      const mine = results.filter((r) => r.key === x.key && r.label === x.label);
      const ok = !protectedKeys.includes(x.key) && mine.find((r) => r.ok);
      const problem = mine.find((r) => !r.ok && !/no longer on this page/.test(r.reason ?? '')) ?? mine[0];
      if (ok) {
        x.origin = aiOriginRecord({ frameId: ok.frameId, documentId: ok.documentId,
          questionHash: aiQuestionHash(x), fieldHash: aiLiveFieldHash({ ...x, current: ok.shown }) });
        x.originAmbiguous = !x.origin;
        x.fieldHash = x.origin?.fieldHash ?? null;
        x.done = sameContext ? decision : 'auto';
        x.error = null;
        if (sameContext) {
          keys.add(x.key);
          x.editScope = editScope(ctx.page);
          state.filled.set(x.key, { path: null, shown: ok.shown });
        }
      } else {
        x.done = null;
        x.error = problem?.reason ?? 'the question is no longer on this page';
      }
      if (sameContext && !ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, ok ? decision : 'failed'));
    }
    if (sameContext) state.agentKeys.set(editOrigin.page, keys);
    // On the quote's finishing step after its action was clicked: the printed proposal is no longer
    // the quote on the page (noteChangedAfterDone), approved or not; so is an edit of the agent's meanwhile.
    if (list.some((x) => x.done) || protectedKeys.length) noteChangedAfterDone(ctx.carrier, ctx.page, tabStep(ctx.carrier, ctx.tabId), ctx.tabId);
    await persistGuardedEdits(editOrigin, protectedKeys);
    // Read the original carrier tab even if the panel has since switched to another intake/tab.
    const after = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null));
    for (const x of list) if (x.done) {
      x.snapshots = after;
      x.snapshotHash = snapshotFingerprint(after);
    }
    if (sameContext) ctx.snapshots = after;
    return true;
  } catch (e) {
    // A transport failure after dispatch does not prove that no carrier field changed.
    for (const x of list) x.error = dispatched
      ? 'the answer was sent but could not be confirmed; review the page before continuing'
      : `couldn't reach the page (${String(e?.message ?? e).slice(0, 80)})`;
    return false;
  } finally {
    if (guarding) {
      try {
        const frames = await runKit(ctx.tabId, ctx.carrier, (t) => globalThis.__raterKit.answerEdits('end', t), [guardToken]);
        // Even a failed answer transport must preserve edits the still-live guards caught.
        const edited = frames.flatMap(frame => frame.result ?? []).filter(item => item?.protected);
        await persistGuardedEdits(editOrigin, edited.map(item => item.key));
      } catch { /* a removed or navigating frame no longer has live listeners */ }
    }
    if (prepared && !dispatched) for (const x of list) x.done = null;
    if (dispatched) for (const [sig, x] of entries) if (list.includes(x) && x.done === 'auto') {
      if (!aiActionCurrent(ctx, list)) {
        x.rejected = true;
        x.label = x.pendingLabel;
        x.choice = x.pendingChoice;
        x.contextKey = null;
        x.autoOk = false;
        x.tip = ''; x.checks = [];
      }
      state.aiCache.set(sig, x);
      aiRetiredSignatures.delete(sig);
    }
    await tellRecorder('resume', ctx.tabId);
    state.filling = false;
    // The recorder was paused while Luna's picks went in, so it won't report the questions they
    // revealed or hid: ask for the page's layout, if that tab is still the one followed (a job
    // is built from the followed tab, and checks the page).
    if (dispatched && state.tab?.id === ctx.tabId) scheduleLayout(ctx.page, 'changed');
    if (prepared) await persistAiPending();
    if (isCurrent() && state.autoPending) scheduleAutoFill(ctx.page);
  }
}

function aiDecisionEvent(x, ctx, decision) {
  const redact = redactor(redactionTerms(state.intake.record));
  return {
    type: 'ai_decision', carrier: ctx.carrier.id, page: ctx.page, q: x.q ?? null, label: redact(x.label), controlKind: x.controlKind,
    decision, choice: x.controlKind !== 'text' && x.choice ? redact(x.choice) : undefined,
    model: x.model, policy: x.policy, basis: x.basis, intakePath: x.intakePath, reason: x.error ? redact(x.error) : undefined,
  };
}

// Each suggestion goes on its question's row (AI suggests …, Use this answer / No thanks; its pick
// marked among the row's own choices), and each pick the AI put in itself says so there, purple,
// with Approve and Reject; the dock approves them all. Above the list: Use all, and any suggestion
// whose question has no row.
function renderAi(holder, suggestions, ctx) {
  const rerender = () => { if (holder.isConnected) renderAi(holder, suggestions, ctx); };
  const act = async (list, decision, button) => {
    if (state.filling) { announce('Wait for the fill to finish, then try again.'); return; }
    if (button) { button.disabled = true; button.textContent = 'Putting it in…'; }
    await applyAi(list, ctx, decision);
    rerender();
  };
  const sure = suggestions.filter((x) => x.autoOk && !x.done && !x.dismissed);
  // Every pick on this page still waiting for approval, also from before an intake or
  // driver/vehicle change (those are labelled), so each one can always be approved or rejected.
  const pending = pendingAi(ctx.tabId, ctx.page);
  const awaiting = pending.filter((x) => !x.rejected);
  const rejectedPending = pending.filter((x) => x.rejected);
  const current = assistContextKey(state.intake?.record, state.active);
  const currentHash = aiFingerprint(current);
  const canContinue = $('auto-advance').checked && !!ctx.carrier.advance;
  // Approving or rejecting acts on a cached pick in this intake and page. A driver/vehicle
  // switch can keep that pick pending; replacing the intake or page invalidates the callback.
  const decide = async (list, decision) => {
    if (state.filling || !aiActionCurrent(ctx, list)) return;
    if (decision === 'approved') {
      // Approve only what the page still shows as the AI left it; a pick whose page changed since
      // is rejected so the agent reviews it after a fresh fill.
      let now;
      try { now = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null)); }
      catch {
        if (!aiActionCurrent(ctx, list)) return;
        for (const x of list) x.error = 'the page is unavailable; return to it and run Fill again';
        rerender();
        return;
      }
      if (!aiActionCurrent(ctx, list)) return;
      const moved = list.filter((x) => !aiCurrentAnswerPresent(now, x) || (x.snapshotHash
        ? !snapshotHashMatches(now, x.snapshotHash)
        : !snapshotsEqual(now, x.snapshots ?? ctx.snapshots)));
      if (moved.length) {
        for (const x of moved) {
          x.rejected = true;
          x.error = 'the page changed after this choice; run Fill again and review it';
          state.agentKeys.get(x.editScope ?? editScope(ctx.page))?.delete(x.key);
        }
        list = list.filter((x) => !moved.includes(x));
        if (!list.length) {
          await persistAiPending();
          await syncAiBanner(ctx);
          rerender();
          return;
        }
      }
    }
    for (const x of list) {
      if (decision === 'approved') x.approved = true; else x.rejected = true;
      if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, decision));
    }
    if (decision === 'rejected') {
      for (const x of list) {
        try { await runKit(ctx.tabId, ctx.carrier, (k, l, n) => globalThis.__raterKit.markKey(k, l, 'needs', n), [x.key, x.label, 'AI choice rejected: set this answer yourself']); } catch { /* page navigating */ }
      }
    }
    await persistAiPending();
    await syncAiBanner(ctx);
    rerender();
    // Approved and nothing else left: the normal fill clicks Continue (when that setting is on).
    if (decision === 'approved' && canContinue && !pendingAi(ctx.tabId, ctx.page).length
      && aiActionCurrent(ctx, list)) fillPage();
  };
  // Rejecting leaves Continue blocked until the agent either changes that field on the page
  // (the recorder marks it manual) or explicitly confirms the current carrier value here. This
  // confirmation is intentional and does not infer consent from unrelated page changes.
  const confirmRejected = async (list) => {
    if (state.filling || !aiActionCurrent(ctx, list)) return;
    for (const x of list) {
      let present = false;
      try {
        const result = await runKit(ctx.tabId, ctx.carrier, () => (globalThis.__raterKit ? globalThis.__raterKit.decisionSnapshot() : null));
        present = aiCurrentAnswerPresent(result, x);
      } catch { /* page navigating */ }
      if (!aiActionCurrent(ctx, list)) return;
      if (present) {
        x.confirmed = true;
        if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, 'rejected_confirmed'));
      } else {
        x.confirmError = 'The page answer changed; review it.';
      }
    }
    await persistAiPending();
    await syncAiBanner(ctx);
    rerender();
    if (canContinue && !pendingAi(ctx.tabId, ctx.page).length
      && aiActionCurrent(ctx, list)) fillPage();
  };
  const why = (x) => [
    x.evidenceSources?.length ? `cited evidence: ${x.evidenceSources.map(source => source.basis === 'intake' ? source.path : 'TNI rule').join(', ')}` : null,
    'Evidence checked · needs your review',
  ].filter(Boolean).join(' · ');
  const answer = (x) => (x.controlKind === 'text' ? `typing “${x.choice}”` : `“${x.choice}”`);
  // Said of a pick waiting for approval that came from before a change, or a retired assistant.
  const notes = (x) => [x.retired ? 'From a retired assistant: review the page answer.' : null,
    (x.contextKey ? x.contextKey !== current : x.contextHash !== currentHash) ? 'Picked before the intake or unit changed.' : null].filter(Boolean);
  // What goes on a row: the suggestion and its buttons, or what happened to it.
  const box = (x) => {
    // The agent's own answer is protected: no fill or AI answer replaces it (agentKeys).
    if (x.manual) return h('div', { class: 'ai-done mine' }, h('b', {}, '✓'), h('span', { class: 'grow' }, 'You changed this answer on the page.'), h('span', { class: 'note' }, 'Won’t be refilled'));
    if (x.rejected) {
      return h('div', { class: 'ai-done bad' }, h('span', { class: 'grow' }, x.confirmError ?? (x.retired ? 'From a retired assistant: review the page answer.' : 'AI answer rejected: answer it on the page.')),
        rejectedPending.includes(x) ? h('button', { type: 'button', class: 'link small ai-reject', onclick: () => confirmRejected([x]) }, 'Confirm the current page answer') : null);
    }
    if (x.error) return h('div', { class: 'ai-done bad' }, `The page didn't take the AI answer (${x.error}). Answer it on the page.`);
    if (x.done === 'auto' && !x.approved) {
      return h('div', { class: 'ai-box' },
        h('div', { class: 'ai-says' }, 'Picked by the AI: ', h('b', {}, x.choice)),
        x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
        ...notes(x).map((n) => h('div', { class: 'ai-tip' }, n)),
        h('div', { class: 'ai-why' }, 'Continue waits for your answer.'),
        h('div', { class: 'ai-actions' },
          h('button', { type: 'button', class: 'primary accept', onclick: () => decide([x], 'approved') }, 'Approve'),
          h('button', { type: 'button', class: 'ghost ai-reject', onclick: () => decide([x], 'rejected') }, 'Reject')));
    }
    if (x.done) return h('div', { class: 'ai-done' }, h('b', {}, '✓'), h('span', { class: 'grow' }, `Put in ${answer(x)} (purple on the page).`));
    if (x.dismissed) return null;
    if (x.leave || !x.applyable) {
      // Its recommendation (luna.js nextStep): what to confirm or check, never an answer.
      return h('div', { class: 'ai-box' }, h('div', { class: 'ai-says' }, x.leave ? 'AI: this one is yours to decide.' : 'AI tip'), x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
        x.leave && x.nextStep ? h('div', { class: 'ai-tip ai-next' }, h('b', {}, 'Luna recommends: '), x.nextStep) : null);
    }
    return h('div', { class: 'ai-box' },
      h('div', { class: 'ai-says' }, 'AI suggests ', h('b', {}, x.controlKind === 'text' ? `typing “${x.choice}”` : x.choice)),
      x.tip ? h('div', { class: 'ai-tip' }, x.tip) : null,
      h('div', { class: 'ai-why' }, why(x)),
      ...x.checks.map((c) => h('div', { class: 'ai-check' }, `Checked by the extension: ${c}`)),
      h('div', { class: 'ai-actions' },
        h('button', { type: 'button', class: 'primary accept', onclick: (e) => act([x], 'accepted', e.target) }, 'Use this answer'),
        h('button', { type: 'button', class: 'ghost', onclick: () => { x.dismissed = true; if (!ctx.carrier.practice) usage.log(aiDecisionEvent(x, ctx, 'dismissed')); rerender(); } }, 'No thanks')));
  };
  const rows = [...$('report').querySelectorAll('.row.need')];
  const orphans = [];
  for (const x of new Set([...suggestions, ...pending])) {
    const item = rows.find((n) => n.dataset.need === `${x.key}|${x.label}`);
    const content = box(x);
    if (!item) {
      if (content) orphans.push(h('div', { class: 'ai-orphan' }, h('b', {}, x.label), content));
      continue;
    }
    item.aiSuggestion = x;
    item.querySelector('.ai-slot').replaceChildren(...(content ? [content] : []));
    // The AI's choice among the row's own: picking it there is accepting it (applyAi).
    const offered = !x.done && !x.dismissed && !x.leave && x.applyable && x.controlKind !== 'text' ? x.choice : null;
    item.aiAccept = offered ? () => act([x], 'accepted') : null;
    if (offered) item.dataset.aiPick = offered; else delete item.dataset.aiPick;
    for (const b of item.querySelectorAll('.opt-btn')) {
      const pick = b.dataset.choice === offered;
      b.classList.toggle('ai-pick', pick);
      b.querySelector('.ai-badge')?.remove();
      if (pick) b.append(h('span', { class: 'ai-badge' }, 'AI pick'));
    }
    for (const o of item.querySelectorAll('.opt-select option')) if (o.value) o.textContent = `${choiceSaid(o.value)}${o.value === offered ? ' (AI pick)' : ''}`;
    // The row says only what the agent settled (answered on the page or here, marked done), else
    // the AI's word: an answer the agent accepted or approved settles it; one waiting for approval
    // (or rejected, or not taken by the page) is still theirs.
    if (['answered', 'marked', 'picked'].includes(item.dataset.settled)) continue;
    item.querySelector('.need-note').hidden = true;
    const settled = !!x.manual || (!!x.done && !x.rejected && !x.error && (x.done !== 'auto' || !!x.approved));
    const waiting = !settled && x.done === 'auto' && !x.rejected && !x.error;
    item.classList.toggle('resolved', settled);
    item.classList.toggle('pending', waiting);
    if (settled) item.dataset.settled = 'ai'; else delete item.dataset.settled;
    setRowHead(item, settled
      ? { icon: '✓', value: x.manual ? 'Your answer on the page' : x.choice, tag: x.manual ? { kind: 'you', text: 'You' }
        : { kind: 'ai', text: x.done === 'auto' ? 'AI · approved' : 'AI · you chose', title: 'AI suggestion, chosen by you' } }
      : waiting ? { icon: '?', value: x.choice, tag: { kind: 'ai', text: 'AI picked · approve', title: 'Picked by the AI: approve or reject it' } }
        : { icon: item.dataset.icon, value: item.dataset.wait });
  }
  holder.replaceChildren(...[
    sure.length > 1 ? h('div', { class: 'ai-actions' }, h('button', { type: 'button', class: 'ghost', onclick: (e) => act(sure, 'accepted', e.target) }, `Use all ${sure.length} AI answers`)) : null,
    ...orphans,
  ].filter(Boolean));
  // The dock's Approve (dockFor): every pick waiting on this page, or the rejected ones confirmed.
  if (pending.length) state.aiDocks.set(`${ctx.tabId}|${ctx.page}`, { canContinue, go: () => (awaiting.length ? decide(awaiting, 'approved') : confirmRejected(rejectedPending)) });
  else state.aiDocks.delete(`${ctx.tabId}|${ctx.page}`);
  recount();
  renderSteps();
}

function wireAi() {
  const save = async patch => {
    // Answers to requests made before are discarded, never kept for a later one (runAssist).
    state.aiSettingsRun = ++state.aiRun;
    state.aiAsking.clear();
    if (Object.hasOwn(patch, 'lunaKey')) {
      for (const [key, value] of state.aiCache) if (!value.done) state.aiCache.delete(key);
    }
    // Keep pending approvals; their cache keys remain bound to the original model and context.
    await usage.saveSettings(patch);
    logSettings('changed', Object.keys(patch).map((k) => ({ aiOn: 'aiOn', lunaAuto: 'aiAuto', lunaKey: 'aiKey' })[k] ?? k).join(','));
    await renderAiSettings();
    // Luna just turned on or got a key: read the open intake's claims box and driver names if not done yet.
    reviewIntake({ retry: true });
  };
  $('ai-on').addEventListener('change', (e) => save({ aiOn: e.target.checked }));
  $('ai-auto').addEventListener('change', (e) => save({ lunaAuto: e.target.checked }));
  // The key is saved with Save (or Enter), never while it is typed.
  const saveKey = async () => {
    await save({ lunaKey: $('ai-openai-key').value.trim() });
    $('ai-openai-key').value = '';
    await openKeyForm(false);
    $('key-edit').focus();
  };
  $('key-edit').addEventListener('click', () => openKeyForm($('key-form').hidden));
  $('key-save').addEventListener('click', saveKey);
  $('ai-openai-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('ai-openai-key').value = ''; openKeyForm(false).then(() => $('key-edit').focus()); }
  });
}

async function renderAiSettings() {
  const cfg = await aiSettings();
  const provider = PROVIDERS[cfg.provider];
  $('ai-on').checked = cfg.on;
  $('ai-auto').checked = cfg.auto;
  $('ai-auto').disabled = !cfg.on || !provider.automatic;
  $('ai-auto-option').hidden = !provider.automatic;
  // No key of the agent's own: the usage server in use lends its key (settingsFrom), so none is
  // needed. TNI's unless a test server is set under Advanced.
  const central = !!cfg.proxy && new URL(cfg.proxy.url).origin === new URL(usage.DEFAULT_SERVER).origin;
  const lender = central ? "TNI's server" : 'the usage server';
  $('key-status').textContent = cfg.apiKey ? 'Saved on this computer' : cfg.proxy ? `Not needed: ${lender} provides it` : 'Not added yet';
  $('key-status').className = cfg.ready ? 'ok' : 'warn';
  if ($('key-form').hidden) $('key-edit').textContent = cfg.apiKey ? 'Change' : cfg.proxy ? 'Use my own key' : 'Add key';
  // On without a key: it can't help yet, said on its card and with a dot on the Settings button.
  $('agent-card').classList.toggle('warn', cfg.on && !cfg.ready);
  // Folded otherwise; opened so that warning isn't hidden.
  if (cfg.on && !cfg.ready) $('assistant').open = true;
  $('ai-note').textContent = !cfg.on ? 'Off' : !cfg.ready ? 'Needs a key'
    : cfg.auto ? 'On. Picks answers you approve.' : 'On. Suggests answers.';
  $('ai-note').className = !cfg.on ? 'off' : !cfg.ready ? 'warn' : 'on';
  renderUsage();
}

export { aiDecisionEvent, aiSettings, applyCheckChoice, claimsTextEdited, ntlAnswerEdited, ntlCargoEdited, ntlPrimaryEdited, pendingAi, remarkAi, renderAiSettings, reviewClaimsBox, reviewDriverGender, reviewIntake, runAssist, syncAiBanner, wireAi };
