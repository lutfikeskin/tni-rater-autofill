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
const fieldName = (e) => quote(e.field?.label || e.field?.key || 'a question');
const docY = (e) => e.field?.rect?.docY ?? null;

// Whether the person did it, as the recorder decides: a click or a key as the browser says (a
// script's isn't trusted); a change only when trusted and within 2 s of their own gesture on that
// control (`gestureMs`), since a script's click on a radio or a box fires trusted input and change
// events too (live recording, 2026-10-23: every radio the fill picked read as the agent's).
const GESTURE_MS = 2000;
const yours = (e) => (e.kind === 'click' || e.kind === 'pointer' || e.kind === 'key' ? e.trusted !== false
  : e.trusted !== false && typeof e.gestureMs === 'number' && e.gestureMs >= 0 && e.gestureMs <= GESTURE_MS);
const whose = (e) => (e.filling ? ' (not you, during a fill)' : ' (the page)');
const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
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
    if (top && e.kind === 'page' && (!current || e.page !== current.page || (e.step ?? null) !== current.step)) open(e, e.page, e.step ?? null);
    else if (top && e.kind === 'step' && current && (e.step ?? null) !== current.step) open(e, current.page, e.step ?? null);
    else if (!current) open(e, e.page ?? '(before the first page event)', null);
    current.events.push(e);
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
      lines.push({ t: e.start ?? e.t, text: `the extension answered ${fieldName(e)} in ${secs(e.applyMs ?? 0)}${after ? `, ${after}` : ''}${e.ok === false ? ' (not kept)' : ''}` });
    } else if (e.kind === 'kit' && e.what === 'wait' && e.why !== 'answer') {
      const held = e.held?.busy ? ', the page still busy' : e.held?.changing ? ', the page still changing' : e.held?.requests ? ', requests still finishing' : '';
      const ended = e.ended === 'quiet' ? 'the page was quiet' : `at its limit of ${secs(e.maxMs ?? 0)}${held}`;
      const slack = e.slack == null ? '' : e.slack >= (e.ms ?? 0) ? '; the page did nothing during it' : `; ${secs(e.slack)} after the page's last change`;
      lines.push({ t: e.start ?? e.t, text: `the extension waited ${secs(e.ms ?? 0)} ${WAITS[e.why] ?? 'for the page'} (quiet ${e.quietMs ?? '?'} ms${e.requests ? ' and its requests' : ''}): ${ended}${slack}` });
    } else if (e.kind === 'kit' && e.what === 'press') lines.push({ t: e.t, text: `the extension pressed the ${quote(e.button?.text)} button` });
    else if (e.kind === 'burst' && (e.drawnCount || e.removed)) {
      const names = (e.drawn ?? []).map((d) => quote(d.label || d.key || 'a question')).join(', ');
      const more = e.drawnCount > (e.drawn?.length ?? 0) ? ', …' : '';
      const drew = e.drawnCount ? `drew ${many(e.drawnCount, 'question')}${names ? ` (${names}${more})` : ''}` : '';
      const took = e.removed ? `took away ${many(e.removed, 'question')}` : '';
      lines.push({ t: e.t, text: `the page ${[drew, took].filter(Boolean).join(' and ')}${e.sinceAction != null ? `, ${secs(e.sinceAction)} after the last action` : ''}` });
    } else if (e.kind === 'fill') lines.push({ t: e.t, text: e.on ? 'a fill started' : `the fill ended${e.ms != null ? ` (it ran ${secs(e.ms)})` : ''}` });
    else if (e.kind === 'note') lines.push({ t: e.t, text: `NOTE: ${e.text}` });
    else if (e.kind === 'gap') lines.push({ t: e.t, text: `GAP: ${e.dropped} event(s) lost while no panel took them` });
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
  const all = { screen: 0, filling: 0, answers: 0, waiting: 0, slack: 0, requests: 0, requestMs: 0 };
  const cells = (r) => `${secs(r.screen)} | ${secs(r.filling)} | ${r.answers} | ${secs(r.waiting)} | ${secs(r.slack)} | ${r.requests} (${secs(r.requestMs)}) | ${secs(r.screen - r.filling)}`;
  for (const { s, next, n } of told) {
    const on = (t) => t >= s.start && t < next;
    const theirs = requests.filter((e) => on(e.t));
    const row = { screen: next - s.start, filling: filling(s.start, next), answers: answers.filter(on).length,
      waiting: within(waits, s.start, next), slack: within(slacks, s.start, next),
      requests: theirs.length, requestMs: theirs.reduce((m, e) => m + (e.ms ?? 0), 0) };
    for (const k of Object.keys(all)) all[k] += row[k];
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${cells(row)} |`);
  }
  out.push(`| | All | ${cells(all)} |`, '');
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
  out.push('Times are from the start (m:ss.s). ↑: an answer above the previous one on the step. Typed text is never kept.', '');

  out.push('## Flow', '', '| # | Page · step | Arrived | On screen | Actions | Left by |', '| --- | --- | --- | --- | --- | --- |');
  const told = segs.map((s, i) => {
    const next = segs[i + 1]?.start ?? end;
    const lines = actions(s.events);
    const lastClick = [...s.events].reverse().find((e) => e.kind === 'click' && e.button && e.trusted !== false);
    return { s, lines, next, lastClick, n: i + 1 };
  });
  for (const { s, lines, next, lastClick, n } of told) {
    out.push(`| ${n} | ${s.page}${s.step ? ` · ${s.step}` : ''} | ${clock(s.start - t0)} | ${secs(next - s.start)} | ${lines.length} | ${lastClick ? quote(lastClick.button.text) : '—'} |`);
  }
  out.push('');
  if (ordered.some((e) => e.kind === 'kit')) out.push(...timeTable(ordered, told, end));

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
