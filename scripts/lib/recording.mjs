// Reads a developer recording (docs/developer-recording.md) and tells it as a story: the pages and
// steps in order with how long each was on screen and what left it, then each step's actions with
// their times and the time since the one before. Typing on one question is one line (its keys and
// final length, never its text); an answer above the previous one on the step is marked ↑; a pause
// over 3 s is named. What wasn't the person's says whose it may be: "not you, during a fill" (the
// extension's, or the page's own script while a fill ran), else "the page".

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
    else if (e.kind === 'fill') lines.push({ t: e.t, text: e.on ? 'a fill started' : `the fill ended${e.ms != null ? ` (it ran ${secs(e.ms)})` : ''}` });
    else if (e.kind === 'note') lines.push({ t: e.t, text: `NOTE: ${e.text}` });
    else if (e.kind === 'gap') lines.push({ t: e.t, text: `GAP: ${e.dropped} event(s) lost while no panel took them` });
    else if (e.kind === 'page' && (e.frame ?? 0) !== 0) lines.push({ t: e.t, text: `a frame loaded ${quote(e.page)}` });
  }
  endTyping();
  endScroll();
  return lines.sort((a, b) => a.t - b.t);
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
