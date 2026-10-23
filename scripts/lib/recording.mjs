// Reads a developer recording (docs/developer-recording.md) and tells it as a story: the pages and
// steps in order with how long each was on screen and what left it, then each step's actions with
// their times and the time since the one before. Typing on one question is one line (its keys and
// final length, never its text); an answer above the previous one on the step is marked ↑; a pause
// over 3 s is named. What isn't trusted (the page's or the extension's own events) says so.

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
  const endTyping = () => {
    if (!typing) return;
    const span = typing.last - typing.first;
    lines.push({ t: typing.first, answer: typing.y, text: `typed into ${typing.name}: ${typing.keys} key${typing.keys === 1 ? '' : 's'}${typing.len != null ? `, length ${typing.len}` : ''}${span > 0 ? ` over ${secs(span)}` : ''}${typing.trusted ? '' : ' (not trusted: the page or the extension)'}` });
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
      typing ??= { key, name: fieldName(e), first: e.t, keys: 0, len: null, y: docY(e), trusted: true };
      typing.last = e.t;
      if (e.kind === 'key') typing.keys++;
      if (e.kind === 'input') { typing.len = e.len; typing.trusted &&= e.trusted !== false; }
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
    const who = e.trusted === false ? ' (not trusted: the page or the extension)' : '';
    const during = e.filling ? ' [during a fill]' : '';
    if (e.kind === 'click') lines.push({ t: e.t, text: `clicked ${e.button ? `the ${quote(e.button.text)} button` : e.field ? `on ${fieldName(e)}` : `a ${e.other?.tag ?? 'page'} element`}${who}${during}` });
    else if (e.kind === 'change' || e.kind === 'input') {
      const prev = lines.at(-1);
      // A choice fires input and change together: one line.
      if (prev?.key === key && prev.value === e.value && e.t - prev.t < 100) continue;
      lines.push({ t: e.t, key, value: e.value, answer: docY(e), text: `picked ${quote(e.value)} for ${fieldName(e)}${who}${during}` });
    } else if (e.kind === 'key') lines.push({ t: e.t, text: `pressed ${e.key}${e.mods ? ` with ${e.mods.join('+')}` : ''}${e.field ? ` in ${fieldName(e)}` : ''}` });
    else if (e.kind === 'visible') lines.push({ t: e.t, text: `the tab became ${e.state}` });
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
