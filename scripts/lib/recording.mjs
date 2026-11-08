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
  helper: 'for a lookup\'s answer' };
// An action the page may answer: anyone's click, key or change, or the fill's answer or press.
const isAction = (e) => ['click', 'key', 'change'].includes(e.kind) || (e.kind === 'kit' && (e.what === 'answer' || e.what === 'press'));

/**
 * `npm run recording -- <zip or folder> [--out file.md]`: the source, and where the report goes
 * (null: the default). Without --out the source is the first argument (it was skipped: live
 * recording, 2026-10-23).
 */
export function cliArgs(argv) {
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] ?? null : null;
  const source = argv.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1)) ?? null;
  return { source, out };
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
      const after = [timing?.settleMs ? `then waited ${secs(timing.settleMs)} for the page` : '', timing?.ajax ? many(timing.ajax, 'request') : '',
        timing?.revealed ? `it drew ${timing.revealed}` : '', timing?.removed ? `took away ${timing.removed}` : ''].filter(Boolean).join(', ');
      lines.push({ t: e.start ?? e.t, text: `${(e.ok === false ? TRIED : BY)[e.source] ?? 'the extension answered'} ${fieldName(e)} in ${secs(e.applyMs ?? 0)}${after ? `, ${after}` : ''}${e.ok === false ? ' (not kept)' : ''}` });
    } else if (e.kind === 'kit' && e.what === 'wait' && e.why !== 'answer') {
      const held = e.held?.busy ? ', the page still busy' : e.held?.changing ? ', the page still changing' : e.held?.requests ? ', requests still finishing' : '';
      const ended = e.ended === 'quiet' ? 'the page was quiet' : `at its limit of ${secs(e.maxMs ?? 0)}${held}`;
      const slack = e.slack == null ? '' : e.slack >= (e.ms ?? 0) ? '; the page did nothing during it' : `; ${secs(e.slack)} after the page's last change`;
      const unseen = e.slackTrace != null && e.slackTrace - e.slack >= 250 ? ` (the wait saw the page change or busy ${secs(e.slackTrace - e.slack)} after the trace's last change: not slack)` : '';
      lines.push({ t: e.start ?? e.t, text: `the extension waited ${secs(e.ms ?? 0)} ${WAITS[e.why] ?? 'for the page'} (quiet ${e.quietMs ?? '?'} ms${e.requests ? ' and its requests' : ''}): ${ended}${slack}${unseen}` });
    } else if (e.kind === 'kit' && e.what === 'press') lines.push({ t: e.t, text: `the extension pressed the ${quote(e.button?.text)} button` });
    else if (e.kind === 'burst' && (e.drawnCount || e.removed)) {
      const names = (e.drawn ?? []).map((d) => quote(d.label || d.key || 'a question')).join(', ');
      const more = e.drawnCount > (e.drawn?.length ?? 0) ? ', …' : '';
      const drew = e.drawnCount ? `drew ${many(e.drawnCount, 'question')}${names ? ` (${names}${more})` : ''}` : '';
      const took = e.removed ? `took away ${many(e.removed, 'question')}` : '';
      lines.push({ t: e.t, text: `the page ${[drew, took].filter(Boolean).join(' and ')}${e.sinceAction != null ? `, ${secs(e.sinceAction)} after the last action` : ''}` });
    } else if (e.kind === 'fill') {
      // What went in (`what`): a fill, the agent's pick from a row, an AI answer (none said: a fill,
      // as recordings before it).
      const [began, ended] = SPANS[e.what] ?? SPANS.fill;
      lines.push({ t: e.t, text: e.on ? began : `${ended}${e.ms != null ? ` (it ran ${secs(e.ms)})` : ''}` });
    }
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
function timeTable(ordered, told, end) {
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
  const out = ['## Where the time went', '',
    "Filling: while a fill ran. Waiting: the fill waiting for the page, after its answers too; slack: the part after the page's last change or request. Without a fill: the person's time, or nobody's.", '',
    '| # | Page · step | On screen | Filling | Answers | Waiting | Slack | Page requests | Without a fill |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  const all = { screen: 0, filling: 0, answers: 0, waiting: 0, slack: 0, requests: 0, requestMs: 0, failed: 0 };
  const cells = (r) => `${secs(r.screen)} | ${secs(r.filling)} | ${r.answers} | ${secs(r.waiting)} | ${secs(r.slack)} | ${r.requests} (${secs(r.requestMs)})${r.failed ? `, ${r.failed} failed` : ''} | ${secs(r.screen - r.filling)}`;
  for (const { s, next, n } of told) {
    const on = (t) => t >= s.start && t < next;
    const theirs = requests.filter((e) => on(e.t));
    const row = { screen: next - s.start, filling: filling(s.start, next), answers: answers.filter(on).length,
      waiting: within(waits, s.start, next), slack: within(slacks, s.start, next),
      requests: theirs.length, requestMs: theirs.reduce((m, e) => m + (e.ms ?? 0), 0), failed: theirs.filter(failed).length };
    for (const k of Object.keys(all)) all[k] += row[k];
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${cells(row)} |`);
  }
  out.push(`| | All | ${cells(all)} |`, '');
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

/** The report, as Markdown. */
export function recordingReport({ manifest, events }) {
  const ordered = [...events].sort((a, b) => a.t - b.t || (a.frame ?? 0) - (b.frame ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  // How long each fill ran, on its end.
  let began = null;
  for (const e of ordered) {
    if (e.kind !== 'fill') continue;
    if (e.on) began = e.t;
    else if (began != null) { e.ms = e.t - began; began = null; }
  }
  // Each wait's slack: how long it went on after the page's last change or request (all of it when
  // the page was quiet from its start). A burst's time since the last action before it.
  // An answer is an action from when it began (its event comes once its wait is over).
  const activity = ordered.filter((e) => e.kind === 'burst' || e.kind === 'request').map((e) => e.end ?? e.t);
  const actionTimes = ordered.filter(isAction).map((e) => (e.kind === 'kit' && e.what === 'answer' ? e.start ?? e.t : e.t));
  for (const e of ordered) {
    if (e.kind === 'kit' && e.what === 'wait' && typeof e.start === 'number' && typeof e.ms === 'number') {
      const waitEnd = e.start + e.ms;
      e.slack = waitEnd - activity.reduce((m, a) => (a <= waitEnd && a > m ? a : m), e.start);
      // What the wait saw itself (REC-02): the attributes it watches, a busy page, an undefined
      // component, a request going; the trace sees none of them. The later of the two counts, and a
      // disagreement is said (`slackTrace`). A recording from before has the trace's alone.
      if (typeof e.lastChange === 'number' || typeof e.lastHeld === 'number') {
        const kitLast = Math.min(waitEnd, Math.max(e.start, e.lastChange ?? e.start, e.lastHeld ?? e.start));
        if (waitEnd - kitLast < e.slack) { e.slackTrace = e.slack; e.slack = waitEnd - kitLast; }
      }
    }
    if (e.kind === 'burst') {
      const last = actionTimes.reduce((m, a) => (a < e.t && (m == null || a > m) ? a : m), null);
      if (last != null) e.sinceAction = e.t - last;
    }
  }
  const t0 = Date.parse(manifest.started) || ordered[0]?.t || 0;
  const end = Date.parse(manifest.ended) || ordered.at(-1)?.t || t0;
  const segs = segments(ordered);
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
  if (awayMs > 0) out.push(`The panel followed another tab for ${secs(awayMs)}: what the quote did there is not in this recording, which follows only the tab it began on.`, '');
  if (ordered.some((e) => e.kind === 'panel' && e.closed)) out.push('The recorded tab was closed, which ended the recording.', '');

  out.push('## Flow', '', '| # | Page · step | Arrived | On screen | Actions | Left by |', '| --- | --- | --- | --- | --- | --- |');
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
  for (const { s, lines, next, leftBy, n } of told) {
    const by = leftBy ? `${quote(leftBy.button.text)} (${leftBy.kind === 'kit' ? 'extension' : 'you'})` : '—';
    const load = s.events.find((e) => e.kind === 'load' && (e.frame ?? 0) === 0 && loadedIn(e) != null);
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${clock(s.start - t0)}${load ? ` (loaded in ${secs(loadedIn(load))})` : ''} | ${secs(next - s.start)} | ${lines.length} | ${by} |`);
  }
  out.push('');
  if (ordered.some((e) => e.kind === 'kit')) out.push(...timeTable(ordered, told, end));
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
