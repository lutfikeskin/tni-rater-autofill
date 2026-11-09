// Reads a developer recording (docs/developer-recording.md) and tells it as a story: the pages and
// steps in order with how long each was on screen and what left it, then each step's actions with
// their times and the time since the one before. Typing on one question is one line (its keys and
// final length, never its text); an answer above the previous one on the step is marked ↑; a pause
// over 3 s is named. What wasn't the person's says whose it may be: "not you, during a fill" (the
// extension's, or the page's own script while a fill ran), else "the page".
//
// What the extension's fill said (`kit` events) and what the page did on its own (`burst`,
// `request`) are in the same timeline: each answer the fill gave and how long it waited for the
// page after it, each other wait with its slack (how long it went on after the page's last change or
// request), the questions the page drew and how long after the last action, and per step where its
// time went (filling, the fill's waits and their slack, the page's requests, the time without a fill).

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { RECORDING_VERSION } from '../../src/recording.js';

const PAUSE_MS = 3000;

/** A recording from its zip, its unzipped folder, or the folder holding that one. */
export function readRecording(source) {
  const files = {};
  if (fs.statSync(source).isDirectory()) {
    const inside = fs.existsSync(path.join(source, 'recording.json')) ? source
      : fs.readdirSync(source).map((n) => path.join(source, n)).find((p) => fs.existsSync(path.join(p, 'recording.json')));
    if (!inside) throw new Error(`no recording.json in ${source}`);
    for (const name of ['recording.json', 'events.jsonl']) files[name] = fs.existsSync(path.join(inside, name)) ? fs.readFileSync(path.join(inside, name), 'utf8') : '';
  } else {
    for (const [name, bytes] of Object.entries(unzipSync(fs.readFileSync(source)))) files[path.posix.basename(name)] = strFromU8(bytes);
  }
  if (!files['recording.json']) throw new Error(`no recording.json in ${source}`);
  const manifest = JSON.parse(files['recording.json']);
  const events = String(files['events.jsonl'] ?? '').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { manifest, events };
}

const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const quote = (s) => `"${String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"`;
// A request's path as code, on one line: decoded, it can hold a line break or Markdown (review of PR #379).
const codePath = (s) => `\`${String(s ?? '').replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, 120)}\``;
// Whose the kit's answer was (REC-14): a fill's (none said), an AI answer's or the agent's pick from
// a row (the kit's `source`, from answer()'s `by`).
const BY = { ai: 'the AI\'s answer went into', agent: 'your pick from the panel went into' };
// One that didn't take: tried, as it may not have been written at all.
const TRIED = { ai: 'the panel tried to put the AI\'s answer into', agent: 'the panel tried to put your pick from the panel into' };
// A document's load (trace.js `load`, stamped at its navigation start), each moment after it.
const LOADED_HOW = { navigate: 'a new page', reload: 'reloaded', back_forward: 'by Back or Forward', prerender: 'prerendered' };
const loadedIn = (e) => (typeof e?.loaded === 'number' ? e.loaded - e.t : null);
const loadLine = (e) => {
  const parts = [typeof e.response === 'number' ? `its server answered in ${secs(e.response - e.t)}` : '',
    typeof e.ready === 'number' ? `ready at ${secs(e.ready - e.t)}` : '', loadedIn(e) != null ? `loaded at ${secs(loadedIn(e))}` : 'not loaded yet as the trace began'].filter(Boolean);
  return `the page loaded (${LOADED_HOW[e.how] ?? 'a page'}): ${parts.join(', ')}`;
};
const fieldName = (e) => quote(e.field?.label || e.field?.key || 'a question');
// Where an answer is down the page; none for a box drawn with no size (a page's hidden status box,
// Progressive's Current Page Errored), which is never above or below a question.
const docY = (e) => (e.field?.rect?.w === 0 && e.field.rect.h === 0 ? null : e.field?.rect?.docY ?? null);

// Whether the person did it, as the recorder decides: a click or a key as the browser says (a
// script's isn't trusted); a change only when trusted and within 2 s of their own gesture on that
// control (`gestureMs`), since a script's click on a radio or a box fires trusted input and change
// events too (live recording, 2026-10-23: every radio the fill picked read as the agent's).
const GESTURE_MS = 2000;
const yours = (e) => (e.kind === 'click' || e.kind === 'pointer' || e.kind === 'key' ? e.trusted !== false
  : e.trusted !== false && typeof e.gestureMs === 'number' && e.gestureMs >= 0 && e.gestureMs <= GESTURE_MS);
const whose = (e) => (e.filling ? ' (not you, during a fill)' : ' (the page)');
const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
// A page request its server answered with an error (HTTP 400 and up; the trace's `status`).
const failed = (e) => Number.isInteger(e.status) && e.status >= 400;
// What the panel was putting in while it was `filling` (the panel's `fillingKind`), as it began and
// ended. The end says it ended, not that it went in: a pick that found no field, or an AI answer
// whose page had changed, ends the same way.
const SPANS = { fill: ['a fill started', 'the fill ended'], pick: ["the panel began putting in the agent's pick from a row", 'the pick ended'],
  ai: ['the panel began putting in an AI answer', 'the AI answer ended'] };
// A wait's own words: what it was for (pagekit.js settle's `why`).
const WAITS = { answer: 'after an answer', round: 'after a round of answers', load: 'for a new view to load', 'before-load': 'before a button that loads a view',
  rated: 'for the premium', continue: 'before pressing Continue', continued: 'after pressing Continue', drawn: 'for a late question', start: 'before the fill',
  helper: 'for a lookup\'s answer', keep: 'before giving again an answer the page didn\'t keep', reset: 'before answering again a choice the page reset',
  pager: 'for another group of vehicles', 'quiet-end': 'for the page to go quiet after the answers', kept: 'to see the answers stayed after Recalculate',
  'put-back': 'after putting back answers the page changed', address: 'for an address suggestion to take', list: 'for a searchable list\'s choice to take' };
// Why an answer didn't take, as the kit's code says it (FailCode, REC-01); another code is said as it is.
const NOT_TAKEN = { 'fill.interrupted': 'not given: you stopped the fill', 'option.no-match': 'not given: no option matched', 'option.ambiguous': 'not given: more than one option matched',
  'answer.refused': 'not given: the field refused it', 'kit.exception': 'not given: the extension failed on it', 'page.unsettled': "not kept: the page didn't settle after it",
  'field.vanished': 'not kept: the question went away after it', 'answer.not-kept': "not kept: the page didn't keep it" };
const notTakenSaid = (code) => NOT_TAKEN[code] ?? (code ? `not kept (\`${code}\`)` : 'not kept');
// How a fill was asked, as its end marker says (core.js, REC-01).
const FILL_HOW = { agent: 'Fill this page', page: 'as the page opened', 'follow-up': 'a follow-up', 'looks-right': 'Looks right', continue: "the dock's Continue" };
// How a wait ended, and its slack, in words.
const endedSaid = (e) => {
  // Each thing that still held it: the page busy, changing, its requests (any of them together).
  const holding = [e.held?.busy && 'the page still busy', e.held?.changing && 'the page still changing', e.held?.requests && 'requests still finishing'].filter(Boolean);
  const held = holding.length ? `, ${holding.join(' and ')}` : '';
  return e.ended === 'quiet' ? 'the page was quiet' : e.ended === 'stopped' ? 'the fill stopped' : `at its limit of ${secs(e.maxMs ?? 0)}${held}`;
};
const slackSaid = (e) => (e.slack == null ? '' : e.running ? 'a page request was still running as it ended: no slack' : e.slack >= (e.ms ?? 0) ? 'the page did nothing during it' : `${secs(e.slack)} after the page's last change`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// An action the page may answer: anyone's click, key or change, or the fill's answer or press.
const isAction = (e) => ['click', 'key', 'change'].includes(e.kind) || (e.kind === 'kit' && (e.what === 'answer' || e.what === 'press'));

/**
 * `npm run recording -- <zip or folder> [--out file.md]`: the source, and where the report goes
 * (null: the default). Without --out the source is the first argument (it was skipped: live
 * recording, 2026-10-23). With `--compare`, its recordings (REC-12): every argument but --out's.
 */
export function cliArgs(argv) {
  // Only --out (with its file) and --compare: a typo or a missing file is said, never run as
  // something else (review of PR #481).
  const unknown = argv.find((a) => a.startsWith('--') && a !== '--out' && a !== '--compare');
  if (unknown) return { error: `unknown option ${unknown}` };
  const outAt = argv.indexOf('--out');
  if (outAt >= 0 && (argv[outAt + 1] == null || argv[outAt + 1].startsWith('--'))) return { error: '--out needs a file name' };
  const out = outAt >= 0 ? argv[outAt + 1] : null;
  const given = argv.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  if (argv.includes('--compare')) return { source: null, out, compare: given };
  return { source: given[0] ?? null, out };
}

/** The top frame's pages and steps, in order, each with its events. */
function segments(events) {
  const out = [];
  let current = null;
  const open = (e, page, step) => {
    current = { page, step, start: e.t, events: [] };
    out.push(current);
  };
  for (const e of events) {
    const top = (e.frame ?? 0) === 0;
    // A new document (`injectedAt`: the trace was in from its load) opens its own step even on the
    // same page and step, so a reload's load is told as its own (review of PR #397).
    if (top && e.kind === 'page' && (!current || e.injectedAt != null || e.page !== current.page || (e.step ?? null) !== current.step)) open(e, e.page, e.step ?? null);
    else if (top && e.kind === 'step' && current && (e.step ?? null) !== current.step) open(e, current.page, e.step ?? null);
    else if (!current) open(e, e.page ?? '(before the first page event)', null);
    // The fill's wait or answer is logged when it ends: one begun on an earlier step (the wait after
    // Continue, which ends on the next page) is told on the step it began on, not before its start.
    const begun = e.kind === 'kit' && typeof e.start === 'number' && e.start < current.start ? out.findLast((x) => x.start <= e.start) : null;
    (begun ?? current).events.push(e);
  }
  return out;
}

/** One step's actions as lines: [t, text, kind] with typing runs merged and repeats dropped. */
function actions(events) {
  const lines = [];
  let typing = null;
  let scrolling = null;
  // Typed by the person (their keys), or set by a script: "set X", whose it may be.
  const endTyping = () => {
    if (!typing) return;
    const span = typing.last - typing.first;
    const length = typing.len != null ? `length ${typing.len}` : '';
    lines.push({ t: typing.first, answer: typing.y, text: typing.keys || typing.yours
      ? `typed into ${typing.name}: ${typing.keys} key${typing.keys === 1 ? '' : 's'}${length ? `, ${length}` : ''}${span > 0 ? ` over ${secs(span)}` : ''}${typing.filling ? ' [during a fill]' : ''}`
      : `set ${typing.name}${length ? ` (${length})` : ''}${whose(typing)}` });
    typing = null;
  };
  const endScroll = () => {
    if (!scrolling) return;
    lines.push({ t: scrolling.t, text: `scrolled to ${scrolling.text}` });
    scrolling = null;
  };
  for (const e of events) {
    const key = e.field?.key ?? null;
    const isTyping = (e.kind === 'key' && e.printable) || (e.kind === 'input' && e.len != null) || (e.kind === 'key' && e.key === 'Backspace');
    if (isTyping && key) {
      endScroll();
      if (typing && typing.key !== key) endTyping();
      typing ??= { key, name: fieldName(e), first: e.t, keys: 0, len: null, y: docY(e), yours: false, filling: false };
      typing.last = e.t;
      typing.filling ||= !!e.filling;
      if (e.kind === 'key') typing.keys++;
      if (e.kind === 'input') { typing.len = e.len; typing.yours ||= yours(e); }
      continue;
    }
    if (e.kind === 'focus' || e.kind === 'blur' || e.kind === 'pointer' || e.kind === 'resize' || (e.kind === 'change' && e.len != null)) continue;
    if (e.kind === 'scroll') {
      endTyping();
      scrolling = { t: e.t, text: e.el ? `${e.top} in <${e.el.tag}${e.el.id ? `#${e.el.id}` : ''}>` : `y=${e.y} of ${e.height ?? '?'}` };
      continue;
    }
    endTyping();
    endScroll();
    // Yours during a fill says so; another's says whose it may be.
    const who = yours(e) ? (e.filling ? ' [yours, during a fill]' : '') : whose(e);
    if (e.kind === 'click') lines.push({ t: e.t, text: `clicked ${e.button ? `the ${quote(e.button.text)} button` : e.field ? `on ${fieldName(e)}` : `a ${e.other?.tag ?? 'page'} element`}${who}` });
    else if (e.kind === 'change' || e.kind === 'input') {
      const prev = lines.at(-1);
      // A choice fires input and change together: one line.
      if (prev?.key === key && prev.value === e.value && e.t - prev.t < 100) continue;
      lines.push({ t: e.t, key, value: e.value, answer: docY(e), text: `${yours(e) ? 'picked' : 'set'} ${quote(e.value)} for ${fieldName(e)}${who}` });
    } else if (e.kind === 'key') lines.push({ t: e.t, text: `pressed ${e.key}${e.mods ? ` with ${e.mods.join('+')}` : ''}${e.field ? ` in ${fieldName(e)}` : ''}` });
    // Once per tab: an older recording has one from each of its frames.
    else if (e.kind === 'visible' && (e.frame ?? 0) === 0) lines.push({ t: e.t, text: `the tab became ${e.state}` });
    else if (e.kind === 'kit' && e.what === 'answer') {
      const timing = e.timing ?? null;
      // The wait after it, with how it ended and its slack when the recording has its event.
      const w = e.answerWait;
      const how = w ? ` (${[endedSaid(w), slackSaid(w)].filter(Boolean).join('; ')})` : '';
      const after = [timing?.settleMs ? `then waited ${secs(timing.settleMs)} for the page${how}` : '', timing?.ajax ? many(timing.ajax, 'request') : '',
        timing?.revealed ? `it drew ${timing.revealed}` : '', timing?.removed ? `took away ${timing.removed}` : ''].filter(Boolean).join(', ');
      lines.push({ t: e.start ?? e.t, text: `${(e.ok === false ? TRIED : BY)[e.source] ?? 'the extension answered'} ${fieldName(e)} in ${secs(e.applyMs ?? 0)}${after ? `, ${after}` : ''}${e.ok === false ? ` (${notTakenSaid(e.code)})` : ''}` });
    } else if (e.kind === 'kit' && e.what === 'wait' && e.why !== 'answer') {
      const slack = slackSaid(e);
      const unseen = e.slackTrace != null && e.slackTrace - e.slack >= 250 ? ` (the wait saw the page change or busy ${secs(e.slackTrace - e.slack)} after the trace's last change: not slack)` : '';
      lines.push({ t: e.start ?? e.t, text: `the extension waited ${secs(e.ms ?? 0)} ${WAITS[e.why] ?? 'for the page'} (quiet ${e.quietMs ?? '?'} ms${e.requests ? ' and its requests' : ''}): ${endedSaid(e)}${slack ? `; ${slack}` : ''}${unseen}` });
    } else if (e.kind === 'kit' && e.what === 'press') lines.push({ t: e.t, text: `the extension pressed the ${quote(e.button?.text)} button` });
    else if (e.kind === 'burst' && (e.drawnCount || e.removed)) {
      const names = (e.drawn ?? []).map((d) => quote(d.label || d.key || 'a question')).join(', ');
      const more = e.drawnCount > (e.drawn?.length ?? 0) ? ', …' : '';
      const drew = e.drawnCount ? `drew ${many(e.drawnCount, 'question')}${names ? ` (${names}${more})` : ''}` : '';
      const took = e.removed ? `took away ${many(e.removed, 'question')}` : '';
      lines.push({ t: e.t, text: `the page ${[drew, took].filter(Boolean).join(' and ')}${e.sinceAction != null ? `, ${secs(e.sinceAction)} after the last action` : ''}` });
    } else if (e.kind === 'fill') {
      // What went in (`what`): a fill, the agent's pick from a row, an AI answer (none said: a fill,
      // as recordings before it). Its end names its run and how it was asked (REC-01).
      const [began, ended] = SPANS[e.what] ?? SPANS.fill;
      const which = e.run ? `: run \`${e.run}\`${e.how ? `, ${FILL_HOW[e.how] ?? e.how}` : ''}` : '';
      lines.push({ t: e.t, text: e.on ? began : `${ended}${e.ms != null ? ` (it ran ${secs(e.ms)})` : ''}${which}` });
    }
    // The page as it was at a moment that mattered (REC-05): its layout file in the recording.
    else if (e.kind === 'moment') lines.push({ t: e.t, text: e.layout ? `the page was saved as ${e.layout} (${e.why}${e.fields != null ? `, ${many(e.fields, 'question')}` : ''})` : `the page couldn't be saved (${e.why}: ${e.error ?? 'error'})` });
    // A request the carrier's server refused or failed (HTTP 400 and up): its own error, not the fill's.
    else if (e.kind === 'request' && failed(e)) lines.push({ t: e.t, text: `the page's request to ${codePath(e.path)} failed: HTTP ${e.status} after ${secs(e.ms ?? 0)}` });
    // A document's load, from its navigation start (REC-03): its server's answer, ready, loaded.
    else if (e.kind === 'load' && (e.frame ?? 0) === 0) lines.push({ t: e.t, text: loadLine(e) });
    else if (e.kind === 'note') lines.push({ t: e.t, text: `NOTE: ${e.text}` });
    else if (e.kind === 'luna') lines.push({ t: e.t, text: lunaLine(e) });
    else if (e.kind === 'gap') lines.push({ t: e.t, text: `GAP: ${e.dropped} event(s) lost while no panel took them` });
    // The panel following another tab than the recorded one (REC-04): the quote may go on there, unrecorded.
    else if (e.kind === 'panel') lines.push({ t: e.t, text: e.closed ? 'THE RECORDED TAB WAS CLOSED: the recording ends here'
      : e.away ? 'THE PANEL MOVED TO ANOTHER TAB: what the quote does there is not in this recording' : 'the panel is back on the recorded tab' });
    else if (e.kind === 'page' && (e.frame ?? 0) !== 0) lines.push({ t: e.t, text: `a frame loaded ${quote(e.page)}` });
  }
  endTyping();
  endScroll();
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * Where each step's time went, for a recording with the extension's account (kit events): how long
 * a fill ran, its answers, its waits for the page and their slack, the page's requests, and the time
 * without a fill (the person's, or nobody's).
 */
function stepTimes(ordered, told, end) {
  const spans = [];
  for (const e of ordered) {
    if (e.kind !== 'fill' || (e.frame ?? 0) !== 0) continue;
    if (e.on) spans.push({ start: e.t, end });
    else if (spans.at(-1)) spans.at(-1).end = e.t;
  }
  const overlap = (from, to, a, b) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  const filling = (a, b) => spans.reduce((sum, f) => sum + overlap(f.start, f.end, a, b), 0);
  // A wait (and its slack, its last part) counts in each step by the part of it on that step: one
  // begun on a step and ended on the next is split. Waits at the same time count once: the fill runs
  // in every frame, each waiting on its own (review of PR #257). An answer and a request count on
  // the step where they began.
  const union = (spans) => spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]).reduce((out, [a, b]) => {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
    return out;
  }, []);
  const waited = ordered.filter((e) => e.kind === 'kit' && e.what === 'wait' && typeof e.start === 'number' && typeof e.ms === 'number');
  const waits = union(waited.map((e) => [e.start, e.start + e.ms]));
  const slacks = union(waited.map((e) => [e.start + e.ms - (e.slack ?? 0), e.start + e.ms]));
  const within = (list, a, b) => list.reduce((m, [from, to]) => m + overlap(from, to, a, b), 0);
  const answers = ordered.filter((e) => e.kind === 'kit' && e.what === 'answer').map((e) => e.start ?? e.t);
  const requests = ordered.filter((e) => e.kind === 'request');
  const all = { screen: 0, filling: 0, answers: 0, waiting: 0, slack: 0, requests: 0, requestMs: 0, failed: 0 };
  const rows = told.map(({ s, next, n }) => {
    const on = (t) => t >= s.start && t < next;
    const theirs = requests.filter((e) => on(e.t));
    const row = { screen: next - s.start, filling: filling(s.start, next), answers: answers.filter(on).length,
      waiting: within(waits, s.start, next), slack: within(slacks, s.start, next),
      requests: theirs.length, requestMs: theirs.reduce((m, e) => m + (e.ms ?? 0), 0), failed: theirs.filter(failed).length };
    for (const k of Object.keys(all)) all[k] += row[k];
    return { s, n, row };
  });
  return { rows, all };
}

/**
 * **Where the time went**, per step and in all (stepTimes).
 * @param {any[]} ordered
 * @param {any[]} told
 * @param {number} end
 */
function timeTable(ordered, told, end) {
  const { rows, all } = stepTimes(ordered, told, end);
  const out = ['## Where the time went', '',
    "Filling: while a fill ran. Waiting: the fill waiting for the page, after its answers too; slack: the part after the page's last change or request. Without a fill: the person's time, or nobody's.", '',
    '| # | Page · step | On screen | Filling | Answers | Waiting | Slack | Page requests | Without a fill |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const cells = (r) => `${secs(r.screen)} | ${secs(r.filling)} | ${r.answers} | ${secs(r.waiting)} | ${secs(r.slack)} | ${r.requests} (${secs(r.requestMs)})${r.failed ? `, ${r.failed} failed` : ''} | ${secs(r.screen - r.filling)}`;
  for (const { s, n, row } of rows) {
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${cells(row)} |`);
  }
  out.push(`| | All | ${cells(all)} |`, '');
  return out;
}

/**
 * How each fill ended, for correctness rather than time (REC-01): per run, as the usage log's
 * fill_run (copied in while recording) says it, what it filled, failed, left for the agent or didn't
 * know, whether it continued and what held it, then each failed, left or unfamiliar question with
 * its reason (fill_field). A fill with no fill_run (a practice page, a recording from before the
 * usage log was copied in) is told by the kit's own end: its counts and its answers not taken.
 */
function outcomes(ordered, t0) {
  const usage = ordered.filter((e) => e.kind === 'usage' && e.event);
  const runs = usage.filter((e) => e.event.type === 'fill_run');
  const ends = ordered.filter((e) => e.kind === 'kit' && e.what === 'run' && e.on === false);
  if (!runs.length && !ends.length) return [];
  const out = ['## Outcome of each fill', ''];
  const marker = (run) => ordered.find((e) => e.kind === 'fill' && e.on === false && e.run === run);
  for (const { t, event: r } of runs) {
    const how = FILL_HOW[marker(r.run)?.how] ?? (r.auto ? (r.auto === true ? 'automatic' : String(r.auto)) : 'Fill this page');
    const blockers = (r.blockerList ?? []).map((b) => quote(b)).join(', ');
    // The usage session is the quote's, not the tab's: a fill on another tab the panel followed is
    // copied in too, so each run names its carrier and view (the tab and unit; review of PR #471).
    out.push(`- ${clock(t - t0)} ${r.carrier ? `${r.carrier} ` : ''}${r.page ?? '?'}${r.step ? ` · ${r.step}` : ''}${r.view ? ` (view \`${r.view}\`)` : ''}, ${how}${r.run ? ` (run \`${r.run}\`)` : ''}: ${r.filled ?? 0} filled, ${r.failed ?? 0} failed, ${r.leftRequired ?? 0} left for you, ${r.unknown ?? 0} unfamiliar, ${r.noData ?? 0} without data; ${r.advanced ? `continued (${quote(r.advanced)})` : 'not continued'}${blockers ? `, held by ${blockers}` : ''}`);
    for (const { event: f } of usage.filter((e) => e.event.type === 'fill_field' && e.event.run === r.run && ['failed', 'leftRequired', 'unfamiliar'].includes(e.event.result))) {
      out.push(`  - ${f.result === 'leftRequired' ? 'left for you' : f.result}: ${quote(f.label || f.key || 'a question')}${f.reason ? `: ${String(f.reason).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
    }
  }
  if (!runs.length) {
    for (const e of ends) {
      const notTaken = ordered.filter((a) => a.kind === 'kit' && a.what === 'answer' && a.ok === false && a.frame === e.frame && (a.start ?? a.t) <= e.t && (a.start ?? a.t) >= (ordered.findLast((x) => x.kind === 'kit' && x.what === 'run' && x.on && x.frame === e.frame && x.t <= e.t)?.t ?? 0));
      out.push(`- ${clock(e.t - t0)} the extension's fill${(e.frame ?? 0) ? ` (frame ${e.frame})` : ''}: ${e.filled ?? 0} filled${e.failed != null ? `, ${e.failed} failed, ${e.leftRequired ?? 0} left for you, ${e.blockers ?? 0} holding Continue, ${e.unknown ?? 0} unfamiliar` : ''}${e.halted ? ', halted' : ''}`);
      for (const a of notTaken) out.push(`  - ${fieldName(a)}: ${notTakenSaid(a.code)}`);
    }
    out.push('', 'No fill_run in this recording (a practice page, or one recorded before the usage log was copied in): the fields left and why are in the usage log.');
  }
  out.push('');
  return out;
}

/**
 * **Waits by kind** (REC-12): the fill's waits grouped by what they were for, each with how many,
 * the median and the longest, how they ended and the median slack, so a review needn't add them up
 * by hand. Each frame's waits count (the fill runs in every frame). None without the fill's waits.
 * @param {any[]} ordered
 */
function waitTable(ordered) {
  const groups = waitGroups(ordered);
  if (!groups.length) return [];
  const out = ['## Waits by kind', '', '| Wait | n | Median | Longest | Quiet | At its limit | Stopped | Median slack |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const g of groups) {
    out.push(`| ${WAITS[g.why] ?? g.why ?? 'for the page'} | ${g.n} | ${secs(g.medianMs)} | ${secs(g.maxMs)} | ${g.quiet} | ${g.limit} | ${g.stopped} | ${g.medianSlackMs == null ? '?' : secs(g.medianSlackMs)} |`);
  }
  out.push('');
  return out;
}

// Luna's calls (kind `luna`, the panel's while a recording runs; audit 2026-11-07, AI-08): one line
// each in the timeline, and what each was asked and answered in the Luna section.
const LEAVE = '__leave__';
// Luna's own words on one line: a line break in them would start Markdown of its own.
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lunaDecisions = (e) => Object.entries(e.answer?.decisions ?? {});
function lunaLine(e) {
  const took = `${secs(e.ms ?? 0)}${e.tokensIn != null ? `, ${e.tokensIn} tokens in, ${e.tokensOut ?? '?'} out` : ''}`;
  if (e.error) return `Luna's ${e.call === 'verify' ? 'evidence check' : 'review'} failed after ${took}: ${oneLine(e.error)}`;
  const all = lunaDecisions(e);
  if (e.call === 'verify') return `Luna checked ${many(all.length, 'answer')}: ${all.filter(([, d]) => d?.supported).length} supported (${took})`;
  const left = all.filter(([, d]) => d?.option === LEAVE).length;
  return `Luna answered ${many(all.length, 'question')}: ${all.length - left} picked, ${left} left (${took})`;
}
function lunaSection(ordered, t0) {
  const calls = ordered.filter((e) => e.kind === 'luna');
  if (!calls.length) return [];
  const out = ['## Luna', '', 'Each call as Luna got it and answered (the intake as sent, redacted; the questions and their options as the page showed them).', ''];
  const cited = (state, id) => {
    const s = state?.sources?.[id];
    if (!s) return `${id} (not a source)`;
    return s.basis === 'tni_rule' ? `${id}: ${quote(String(s.rule ?? '').slice(0, 120))}` : `${s.path} = ${oneLine(JSON.stringify(s.value))}`;
  };
  for (const e of calls) {
    out.push(`### ${clock(e.t - t0)} · ${e.call === 'verify' ? 'evidence check' : 'review'} · ${e.page ?? '?'} · ${e.model ?? '?'}`, '', `- ${lunaLine(e)}`);
    const decisions = Object.fromEntries(lunaDecisions(e));
    if (e.call === 'verify') {
      for (const [id, p] of Object.entries(e.request?.proposed ?? {})) {
        const d = decisions[id];
        out.push(`- ${quote(p.label)}: ${quote(p.answer)} on ${(p.sourceIds ?? []).map((s) => cited(e.request, s)).join('; ') || 'nothing'} → ${d ? (d.supported ? 'supported' : `not supported: ${oneLine(d.gap) || 'no reason given'}`) : 'no answer'}`);
      }
    } else {
      for (const [id, f] of Object.entries(e.request?.fields ?? {})) {
        const d = decisions[id];
        const pick = !d ? 'no answer' : d.option === LEAVE ? 'left' : `picked ${quote(f.options?.[d.option] ?? d.option)}`;
        out.push(`- ${quote(f.label)}${f.current ? ` (on the page: ${quote(f.current)})` : ''}: ${pick}`);
        if (d?.sourceIds?.length) out.push(`  - cited: ${d.sourceIds.map((s) => cited(e.request, s)).join('; ')}`);
        if (d?.explanation) out.push(`  - why: ${oneLine(d.explanation)}`);
        for (const [k, said] of [['missingInformation', 'missing'], ['conflicts', 'conflict']]) if (d?.[k]?.length) out.push(`  - ${said}: ${d[k].map(oneLine).join(' · ')}`);
      }
    }
    out.push('');
  }
  return out;
}

/**
 * The fill's waits grouped by what they were for (its `why`, null for none), in the order first seen:
 * how many, the median and longest ms, how many ended quiet, at their limit or stopped, and the
 * median slack (null where none is known). Each frame's waits count.
 * @param {any[]} ordered
 */
function waitGroups(ordered) {
  const waits = ordered.filter((e) => e.kind === 'kit' && e.what === 'wait' && typeof e.ms === 'number');
  return [...new Set(waits.map((e) => e.why ?? null))].map((why) => {
    const of = waits.filter((e) => (e.why ?? null) === why);
    const count = (ended) => of.filter((e) => e.ended === ended).length;
    const slacks = of.map((e) => e.slack).filter((s) => typeof s === 'number');
    return { why, n: of.length, medianMs: median(of.map((e) => e.ms)), maxMs: Math.max(...of.map((e) => e.ms)), quiet: count('quiet'), limit: count('limit'), stopped: count('stopped'),
      medianSlackMs: slacks.length ? median(slacks) : null };
  });
}

/**
 * A recording read once for the report and the summary: its events in order, each fill's `ms`, each
 * wait's `slack` and each answer's own wait worked out, its start and end, and its steps (`told`,
 * each with its lines, its end and what left it).
 */
function prepared({ manifest, events }) {
  const ordered = [...events].sort((a, b) => a.t - b.t || (a.frame ?? 0) - (b.frame ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  // How long each fill ran, on its end.
  let began = null;
  for (const e of ordered) {
    if (e.kind !== 'fill') continue;
    if (e.on) began = e.t;
    else if (began != null) { e.ms = e.t - began; began = null; }
  }
  // Each wait's slack: how long it went on after the page's last change or request (all of it when
  // the page was quiet from its start), in its own frame: a wait watches its own document, so another
  // frame's change didn't hold it. A burst's time since the last action before it.
  // An answer is an action from when it began (its event comes once its wait is over).
  const requests = ordered.filter((e) => e.kind === 'request');
  const activity = ordered.filter((e) => e.kind === 'burst' || e.kind === 'request').map((e) => ({ at: e.end ?? e.t, frame: e.frame ?? 0 }));
  const actionTimes = ordered.filter(isAction).map((e) => (e.kind === 'kit' && e.what === 'answer' ? e.start ?? e.t : e.t));
  for (const e of ordered) {
    if (e.kind === 'kit' && e.what === 'wait' && typeof e.start === 'number' && typeof e.ms === 'number') {
      const waitEnd = e.start + e.ms;
      e.slack = waitEnd - activity.reduce((m, a) => (a.frame === (e.frame ?? 0) && a.at <= waitEnd && a.at > m ? a.at : m), e.start);
      // What the wait saw itself (REC-02): the attributes it watches, a busy page, an undefined
      // component, a request going; the trace sees none of them. The later of the two counts, and a
      // disagreement is said (`slackTrace`). A recording from before has the trace's alone.
      if (typeof e.lastChange === 'number' || typeof e.lastHeld === 'number') {
        const kitLast = Math.min(waitEnd, Math.max(e.start, e.lastChange ?? e.start, e.lastHeld ?? e.start));
        if (waitEnd - kitLast < e.slack) { e.slackTrace = e.slack; e.slack = waitEnd - kitLast; }
      }
      // A request is said as it ends (its event's `t` is its start): one in the wait's frame that began
      // before the wait ended and ended after it was still running then, so none of the wait is
      // slack (review of PR #481).
      e.running = requests.some((r) => (r.frame ?? 0) === (e.frame ?? 0) && r.t < waitEnd && (r.end ?? r.t) > waitEnd);
      if (e.running) e.slack = 0;
    }
    if (e.kind === 'burst') {
      const last = actionTimes.reduce((m, a) => (a < e.t && (m == null || a > m) ? a : m), null);
      if (last != null) e.sinceAction = e.t - last;
    }
  }
  // Each answer's own wait: the frame's answer wait that ran between the answer's start and its event,
  // said by then (a wait said after the answer is the next answer's, though it began in the same ms).
  const answerWaits = ordered.filter((e) => e.kind === 'kit' && e.what === 'wait' && e.why === 'answer' && typeof e.start === 'number');
  for (const e of ordered) {
    if (e.kind !== 'kit' || e.what !== 'answer' || typeof e.start !== 'number') continue;
    e.answerWait = answerWaits.findLast((w) => (w.frame ?? 0) === (e.frame ?? 0) && w.start >= e.start && w.start <= e.t && w.t <= e.t) ?? null;
  }
  const t0 = Date.parse(manifest.started) || ordered[0]?.t || 0;
  const end = Date.parse(manifest.ended) || ordered.at(-1)?.t || t0;
  const segs = segments(ordered);
  const told = segs.map((s, i) => {
    const next = segs[i + 1]?.start ?? end;
    // In time order: a wait moved here from a later step is logged after this step's own lines.
    const lines = actions(s.events).sort((x, y) => x.t - y.t);
    // Left by the last button pressed on it: the agent's (a trusted click) or the extension's (the
    // kit's press), whichever came last (REC-13, 2026-11-07: the agent's earlier click was named when
    // the fill pressed Continue, and a step only the fill left showed none).
    const leftBy = s.events.filter((e) => e.button && ((e.kind === 'click' && e.trusted !== false) || (e.kind === 'kit' && e.what === 'press')))
      .reduce((last, e) => (!last || e.t >= last.t ? e : last), null);
    return { s, lines, next, leftBy, n: i + 1 };
  });
  return { ordered, t0, end, told };
}

/** The report, as Markdown. */
export function recordingReport({ manifest, events }) {
  const { ordered, t0, end, told } = prepared({ manifest, events });
  const out = [`# Recording ${manifest.id}`, ''];
  out.push(`${manifest.carrier} · scenario ${quote(manifest.scenario)} · ${new Date(t0).toISOString()} · ${clock(end - t0)} long · ${ordered.length} events${manifest.dropped ? ` (${manifest.dropped} lost)` : ''}`);
  out.push(`Build ${manifest.build?.version ?? '?'} (${manifest.build?.channel ?? '?'}${manifest.build?.commit ? `, ${manifest.build.commit}` : ''})${manifest.test ? ' · a test run' : ''}${manifest.ended ? '' : ' · cut short (no end)'}`, '');
  // What the run needs to be reproduced (format 2 on, REC-10), and a format newer than this report.
  if ((manifest.version ?? 1) > RECORDING_VERSION) out.push(`**This recording's format is version ${manifest.version}; this report reads up to ${RECORDING_VERSION}: what it says may be incomplete or wrong. Update the repository first.**`, '');
  if ((manifest.version ?? 1) >= 2) {
    const s = manifest.settings;
    const on = s ? Object.entries({ 'auto-advance': s.autoAdvance, 'follow-ups': s.autoFollowUps, 'automatic pages': s.autoPages, 'check before Continue': s.checkBeforeContinue })
      .filter(([, v]) => v != null).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ') : '?';
    out.push(`Rules ${manifest.rules ?? '?'} · defaults ${manifest.defaultsHash ?? "TNI's"} · ${on} · trace ${manifest.versions?.trace ?? '?'}, recorder ${manifest.versions?.recorder ?? '?'} · ${manifest.platform ?? '?'} · session ${manifest.session ?? '?'}`, '');
  }
  out.push('Times are from the start (m:ss.s). ↑: an answer above the previous one on the step. Typed text is never kept.', '');
  // The carrier's own server errors, said up front: a step that failed on them isn't the fill's.
  const errors = ordered.filter((e) => e.kind === 'request' && failed(e));
  if (errors.length) {
    const byStatus = [...new Set(errors.map((e) => e.status))].sort((a, b) => a - b).map((s) => `HTTP ${s} ×${errors.filter((e) => e.status === s).length}`).join(', ');
    out.push(`The page's server answered ${many(errors.length, 'request')} with an error (${byStatus}): each is in its step's timeline.`, '');
  }
  // The panel away from the recorded tab (REC-04): said up front, with how long, since the quote may
  // have gone on in the tab the panel followed.
  let awayMs = 0;
  let awayFrom = null;
  for (const e of ordered.filter((x) => x.kind === 'panel' && !x.closed)) {
    if (e.away && awayFrom == null) awayFrom = e.t;
    else if (!e.away && awayFrom != null) { awayMs += e.t - awayFrom; awayFrom = null; }
  }
  if (awayFrom != null) awayMs += end - awayFrom;
  if (awayMs > 0) out.push(`The panel followed another tab for ${secs(awayMs)}: its pages are not traced in this recording, which follows only the tab it began on; a fill there still shows in **Outcome of each fill**, under its carrier and view, since the usage log is the quote's.`, '');
  if (ordered.some((e) => e.kind === 'panel' && e.closed)) out.push('The recorded tab was closed, which ended the recording.', '');

  out.push('## Flow', '', '| # | Page · step | Arrived | On screen | Actions | Left by |', '| --- | --- | --- | --- | --- | --- |');
  for (const { s, lines, next, leftBy, n } of told) {
    const by = leftBy ? `${quote(leftBy.button.text)} (${leftBy.kind === 'kit' ? 'extension' : 'you'})` : '—';
    const load = s.events.find((e) => e.kind === 'load' && (e.frame ?? 0) === 0 && loadedIn(e) != null);
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${clock(s.start - t0)}${load ? ` (loaded in ${secs(loadedIn(load))})` : ''} | ${secs(next - s.start)} | ${lines.length} | ${by} |`);
  }
  out.push('');
  if (ordered.some((e) => e.kind === 'kit')) out.push(...timeTable(ordered, told, end));
  out.push(...outcomes(ordered, t0));
  out.push(...waitTable(ordered));
  out.push(...lunaSection(ordered, t0));

  for (const { s, lines, n } of told) {
    out.push(`## ${n}. ${s.page}${s.step ? ` · ${s.step}` : ''}`, '');
    if (!lines.length) { out.push('Nothing done here.', ''); continue; }
    let prevT = s.start;
    let prevY = null;
    for (const line of lines) {
      const gap = line.t - prevT;
      const up = line.answer != null && prevY != null && line.answer < prevY ? ' ↑' : '';
      out.push(`- ${clock(line.t - t0)} (+${secs(gap)}${gap > PAUSE_MS ? ', a pause' : ''})${up} ${line.text}`);
      prevT = line.t;
      if (line.answer != null) prevY = line.answer;
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * The recording's numbers as data (REC-12): what a review reads off the report by hand, for
 * scripts and for `--compare`. Its steps (where the time went, in ms, and what left each), its waits
 * by kind (as **Waits by kind**), the fill's answers in the order given (the field's key and label as
 * the trace redacted them, whether the page kept it and, when not, why) and the buttons it pressed.
 * Never a value: the trace keeps none.
 * @param {{ manifest: any, events: any[] }} recording
 */
export function recordingSummary({ manifest, events }) {
  const { ordered, t0, end, told } = prepared({ manifest, events });
  const { rows, all } = stepTimes(ordered, told, end);
  const at = (t) => Math.round(t - t0);
  const stepOf = (t) => told.findLast(({ s }) => s.start <= t)?.n ?? 1;
  const time = (r) => ({ onScreenMs: r.screen, fillingMs: r.filling, answers: r.answers, waitingMs: r.waiting, slackMs: r.slack, requests: r.requests, requestMs: r.requestMs, failedRequests: r.failed });
  return {
    summary: 1, id: manifest.id, carrier: manifest.carrier, scenario: manifest.scenario ?? null, started: manifest.started ?? null, ended: manifest.ended ?? null,
    build: manifest.build ?? null, events: ordered.length,
    steps: rows.map(({ s, n, row }) => {
      const leftBy = told[n - 1].leftBy;
      return { n, page: s.page, step: s.step, arrivedMs: at(s.start), ...time(row), leftBy: leftBy ? { button: leftBy.button.text ?? '', by: leftBy.kind === 'kit' ? 'extension' : 'you' } : null };
    }),
    all: time(all),
    waits: waitGroups(ordered),
    answers: ordered.filter((e) => e.kind === 'kit' && e.what === 'answer').map((e) => ({ key: e.field?.key ?? null, label: e.field?.label ?? '', ok: e.ok !== false,
      ...(e.ok === false && e.code ? { code: e.code } : {}), ...(e.source ? { source: e.source } : {}), step: stepOf(e.start ?? e.t), atMs: at(e.start ?? e.t) })),
    presses: ordered.filter((e) => e.kind === 'kit' && e.what === 'press').map((e) => ({ button: e.button?.text ?? '', step: stepOf(e.t), atMs: at(e.t) })),
  };
}

/**
 * Two recordings of the same quote side by side (REC-12, `npm run recording -- --compare a b`):
 * the proof that a change (a shortened wait, a new rule) still answered the same things. What A's
 * fill answered and kept that B's didn't comes first and is flagged, then what B answered that A
 * didn't, answers kept in one and not the other, the buttons the fill pressed, the waits by kind
 * (n and median) and the totals. Answers are matched by their field's key (its label when it has
 * none), as the trace redacted it.
 * @param {ReturnType<typeof recordingSummary>} a
 * @param {ReturnType<typeof recordingSummary>} b
 */
export function compareReport(a, b) {
  const keyOf = (x) => x.key ?? `label:${x.label}`;
  const lastBy = (answers) => {
    const m = new Map();
    for (const x of answers) m.set(keyOf(x), x);
    return m;
  };
  const A = lastBy(a.answers), B = lastBy(b.answers);
  const name = (x) => quote(x.label || x.key || 'a question');
  // A key counts as kept by how many of its answers the page kept, not by its last attempt: a refill
  // that failed after two kept answers leaves both kept (review of PR #481). GEICO gives each
  // vehicle's form the same keys, so one vehicle's answer missing in B leaves the key answered: a key
  // kept fewer times in B is flagged. A refill of a kept answer counts too, so a flag is a question to
  // look at, not proof, and equal counts can still hide a missing unit the trace doesn't name.
  const keptTimes = (s) => s.answers.reduce((m, x) => (x.ok ? m.set(keyOf(x), (m.get(keyOf(x)) ?? 0) + 1) : m), new Map());
  const timesA = keptTimes(a), timesB = keptTimes(b);
  const inA = (k) => timesA.get(k) ?? 0, inB = (k) => timesB.get(k) ?? 0;
  const onlyA = [...A.keys()].filter((k) => inA(k) && !B.has(k));
  const onlyB = [...B.keys()].filter((k) => inB(k) && !A.has(k));
  const lostInB = [...A.keys()].filter((k) => inA(k) && B.has(k) && !inB(k));
  const gainedInB = [...B.keys()].filter((k) => inB(k) && A.has(k) && !inA(k));
  const fewerInB = [...A.keys()].filter((k) => inB(k) && inB(k) < inA(k));
  const out = [`# Recordings compared: A ${a.id} · B ${b.id}`, '',
    `A: ${a.carrier} · ${quote(a.scenario)} · build ${a.build?.version ?? '?'}${a.build?.commit ? ` (${a.build.commit})` : ''} · ${many(a.answers.length, 'answer')} · ${secs(a.all.onScreenMs)}`,
    `B: ${b.carrier} · ${quote(b.scenario)} · build ${b.build?.version ?? '?'}${b.build?.commit ? ` (${b.build.commit})` : ''} · ${many(b.answers.length, 'answer')} · ${secs(b.all.onScreenMs)}`, ''];
  if (a.carrier !== b.carrier) out.push('**Not the same carrier: the answers can\'t be compared.**', '');
  out.push('## Answers', '');
  if (!onlyA.length && !lostInB.length && !fewerInB.length) out.push('Every answer A\'s fill gave and the page kept, B\'s gave and the page kept too.');
  for (const k of onlyA) out.push(`- **NOT ANSWERED IN B**: ${name(A.get(k))} (step ${A.get(k).step} in A)`);
  for (const k of lostInB) out.push(`- **NOT KEPT IN B**: ${name(B.get(k))}${B.get(k).code ? ` (\`${B.get(k).code}\`)` : ''}, kept in A`);
  for (const k of fewerInB) out.push(`- **KEPT FEWER TIMES IN B**: ${name(A.get(k))}, ${timesA.get(k)} times in A, ${timesB.get(k) ?? 0} in B (one for each vehicle, driver or trailer, or a refill)`);
  for (const k of onlyB) out.push(`- answered in B only: ${name(B.get(k))} (step ${B.get(k).step} in B)`);
  for (const k of gainedInB) out.push(`- kept in B, not in A: ${name(A.get(k))}${A.get(k).code ? ` (\`${A.get(k).code}\` in A)` : ''}`);
  out.push('', '## Buttons the fill pressed', '');
  const presses = (s) => s.presses.map((p) => p.button);
  if (JSON.stringify(presses(a)) === JSON.stringify(presses(b))) out.push(`The same, in the same order: ${presses(a).map(quote).join(', ') || 'none'}.`);
  else out.push(`- A: ${presses(a).map(quote).join(', ') || 'none'}`, `- B: ${presses(b).map(quote).join(', ') || 'none'}`);
  out.push('', '## Waits by kind', '', '| Wait | A n | A median | B n | B median | Median change |', '| --- | --- | --- | --- | --- | --- |');
  const kinds = [...new Set([...a.waits, ...b.waits].map((g) => g.why ?? null))];
  for (const why of kinds) {
    const x = a.waits.find((g) => (g.why ?? null) === why), y = b.waits.find((g) => (g.why ?? null) === why);
    const change = x && y ? `${y.medianMs - x.medianMs >= 0 ? '+' : '−'}${secs(Math.abs(y.medianMs - x.medianMs))}` : '—';
    out.push(`| ${WAITS[why] ?? why ?? 'for the page'} | ${x?.n ?? 0} | ${x ? secs(x.medianMs) : '—'} | ${y?.n ?? 0} | ${y ? secs(y.medianMs) : '—'} | ${change} |`);
  }
  out.push('', '## Time', '', '| | A | B |', '| --- | --- | --- |');
  for (const [label, k] of [['On screen', 'onScreenMs'], ['Filling', 'fillingMs'], ['Waiting', 'waitingMs'], ['Slack', 'slackMs']]) out.push(`| ${label} | ${secs(a.all[k])} | ${secs(b.all[k])} |`);
  out.push(`| Answers | ${a.all.answers} | ${b.all.answers} |`, '');
  return out.join('\n');
}
