// @ts-check
// The quote summary (audit 2026-11-07, UX-05): every answer of the quote in one place, per carrier
// and page, with where it came from, then what the agent overrode, what the AI decided and what was
// marked done without an answer. Read from the pages' reports (state.reports: their row records,
// report-rows.js) and the intake, as they are when it is opened; it reads nothing from, and changes
// nothing on, a carrier page. `summaryHtml` writes it as one HTML file, which Save summary puts in
// Downloads. No DOM but the download.
// One part of the panel; sidepanel.js wires the parts together.
import { fieldInfo } from '../../src/schema.js';
import { get, STATES } from '../../src/util.js';
import * as usage from '../usage-log.js';
import { $, state } from './core.js';
import { showScreen } from './record.js';
import { reportTitle } from './report-model.js';
import { rowHead } from './report-rows.js';
import { flushSync } from 'react-dom';

/** @import { QuoteSummary, QuoteSummaryRow } from '../../types.js' */

// Where a summary row's answer came from, as the summary says it: the report's own tags (fill.js
// answerSource), and what happened to an item left for the agent.
const SOURCES = {
  intake: 'Intake',
  derived: 'Worked out',
  standard: 'TNI standard',
  own: 'Your default',
  edited: 'Your edit',
  ai: 'AI',
  you: 'You',
  page: 'On the page',
  clicked: 'Clicked',
  changed: 'Changed on the page',
  marked: 'Marked done',
  pending: 'AI picked, not approved',
  open: 'Left for you',
};

// The order the sources are counted in on a page's line (most of a quote first).
const SOURCE_ORDER = Object.keys(SOURCES);

// An answer as the summary writes it.
const said = (v) => (v === true ? 'Yes' : v === false ? 'No' : v == null || v === '' ? '—' : String(v));

/**
 * One row of a page's report (report-rows.js answerRecord or needRecord) as the summary lists it, or
 * null for one that holds nothing now (a question gone from the page).
 * @param {any} rec
 * @returns {QuoteSummaryRow | null}
 */
function summaryRow(rec) {
  if (rec.gone) return null;
  const head = rowHead(rec, rec.source?.tag ?? null);
  if (rec.type === 'answer') {
    const source = rec.kind === 'page' && rec.standard ? 'standard' : rec.kind === 'yours' ? 'you' : rec.kind;
    return { label: String(rec.label ?? ''), value: said(head.value), source, sourceSaid: SOURCES[source] ?? String(source),
      note: rec.changed ? String(rec.changed) : null };
  }
  const why = rec.x?.why ? String(rec.x.why) : null;
  const label = String(rec.label ?? '');
  if (rec.settled === 'marked') return { label, value: 'Marked done', source: 'marked', sourceSaid: SOURCES.marked, note: why };
  if (rec.settled === 'ai') {
    const mine = head.tag?.kind === 'you';
    return { label, value: said(head.value), source: mine ? 'you' : 'ai', sourceSaid: mine ? SOURCES.you : head.tag?.text ?? SOURCES.ai, note: why };
  }
  if (rec.settled) return { label, value: said(head.value), source: 'you', sourceSaid: head.tag?.title ?? SOURCES.you, note: why };
  if (rec.pending) return { label, value: said(head.value), source: 'pending', sourceSaid: SOURCES.pending, note: why };
  const rejected = rec.ai?.rejected ? 'The AI’s answer was rejected.' : null;
  return { label, value: rec.wait ?? 'Left for you', source: 'open', sourceSaid: SOURCES.open, note: [why, rejected].filter(Boolean).join(' ') || null };
}

// An intake field as the summary names it: its label, with which driver, vehicle or trailer
// ("Driver 2: Date of birth").
function fieldSaid(path) {
  const unit = /^(drivers|vehicles|trailers)\[(\d+)\]/.exec(path);
  const label = fieldInfo(path)?.label ?? path;
  return unit ? `${{ drivers: 'Driver', vehicles: 'Vehicle', trailers: 'Trailer' }[unit[1]]} ${Number(unit[2]) + 1}: ${label}` : label;
}

// What a page's report says instead of answers, or above them: its fill halted, the agent stopped
// it, it found nothing to fill.
function pageSaid(entry) {
  if (entry.error) return String(entry.error);
  if (entry.stopped) return 'You stopped the fill. What went in stays.';
  if (entry.halted) return 'The fill stopped short on this page.';
  return entry.notice ? String(entry.notice) : null;
}

/**
 * The quote's summary, from the reports of the tabs still open and the intake. `quoteStates`: the
 * tabs' quote states (coordinator.js stateIssue), for the ones the agent said were right.
 * @param {{ reports?: Map<string, any>, intake?: any, quoteStates?: Map<number, any>, intakeId?: string | null, at?: Date, version?: string }} from
 * @returns {QuoteSummary}
 */
function quoteSummary({ reports = new Map(), intake = null, quoteStates = new Map(), intakeId = null, at = new Date(), version = '' } = {}) {
  const record = intake?.record ?? {};
  const g = record.garaging ?? {};
  /** @type {QuoteSummary['carriers']} */
  const carriers = [];
  // One group per tab, in the order its first page was filled; a carrier's second tab is named so.
  for (const entry of reports.values()) {
    if (!entry?.carrier) continue;
    let group = carriers.find((c) => c.tabId === entry.tabId);
    if (!group) {
      const nth = carriers.filter((c) => c.id === entry.carrier.id).length + 1;
      group = { id: String(entry.carrier.id), name: `${entry.carrier.name}${nth > 1 ? ` (tab ${nth})` : ''}`, tabId: entry.tabId, practice: !!entry.carrier.practice, pages: [] };
      carriers.push(group);
    }
    const rows = (entry.list ?? []).map(summaryRow).filter(Boolean);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1;
    group.pages.push({ title: reportTitle(entry) || String(entry.page ?? 'Page'), at: new Date(entry.at ?? at).toISOString(), said: pageSaid(entry),
      counts: SOURCE_ORDER.filter((k) => counts[k]).map((k) => ({ source: k, sourceSaid: SOURCES[k], n: counts[k] })), rows });
  }
  const placed = carriers.flatMap((c) => c.pages.flatMap((p) => p.rows.map((r) => ({ ...r, carrier: c.name, page: p.title }))));
  // The agent's corrections to the intake, what they answered or changed on a page, their own
  // defaults, and a quote state they kept though the intake says another.
  const edits = (intake?.agentEdited ?? []).map((path) => ({ kind: 'edit', carrier: null, page: null, label: fieldSaid(path),
    value: said(get(record, path)), said: 'Corrected in the panel' }));
  const states = [...quoteStates].filter(([, p]) => p?.dismissed && p.dismissed === `${intakeId}|${p.code}`).map(([tabId, p]) => ({ kind: 'state',
    carrier: carriers.find((c) => c.tabId === tabId)?.name ?? p.carrier ?? null, page: null,
    label: 'Quote state', value: STATES[p.code] ?? String(p.code), said: `Kept, though the intake says ${STATES[g.state] ?? g.state ?? 'another state'}` }));
  const onPages = placed.filter((r) => ['you', 'changed', 'own', 'edited'].includes(r.source))
    .map((r) => ({ kind: r.source, carrier: r.carrier, page: r.page, label: r.label, value: r.value, said: r.sourceSaid }));
  return {
    client: { name: record.applicant?.name || record.applicant?.owner1 || 'Unnamed business', fileName: intake?.fileName ?? null, state: STATES[g.state] ?? g.state ?? null },
    at: at.toISOString(),
    version,
    carriers,
    overrides: [...edits, ...states, ...onPages],
    ai: placed.filter((r) => r.source === 'ai' || r.source === 'pending' || /AI’s answer was rejected/.test(r.note ?? '')),
    marked: placed.filter((r) => r.source === 'marked'),
    open: placed.filter((r) => r.source === 'open').length,
    answers: placed.filter((r) => !['open', 'marked', 'pending'].includes(r.source)).length,
  };
}

// Text in HTML.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The summary as one HTML file, styles inline, no scripts: what Save summary saves.
 * @param {QuoteSummary} s
 */
function summaryHtml(s) {
  const when = new Date(s.at).toLocaleString();
  const list = (title, rows, line) => (rows.length ? `<h2>${esc(title)} (${rows.length})</h2><ul>${rows.map((r) => `<li>${line(r)}</li>`).join('')}</ul>` : '');
  const where = (r) => [r.carrier, r.page].filter(Boolean).map(esc).join(' · ');
  const pages = s.carriers.map((c) => `<h2>${esc(c.name)}${c.practice ? ' (practice page)' : ''}</h2>${c.pages.map((p) => `
<h3>${esc(p.title)}</h3>
${p.said ? `<p class="said">${esc(p.said)}</p>` : ''}
${p.counts.length ? `<p class="counts">${p.counts.map((k) => `${esc(k.sourceSaid)}: ${k.n}`).join(' · ')}</p>` : ''}
${p.rows.length ? `<table><thead><tr><th>Question</th><th>Answer</th><th>Source</th></tr></thead><tbody>${p.rows.map((r) => `<tr class="${esc(r.source)}"><td>${esc(r.label)}</td><td>${esc(r.value)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</td><td>${esc(r.sourceSaid)}</td></tr>`).join('')}</tbody></table>` : ''}`).join('')}`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quote summary: ${esc(s.client.name)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;color:#1d2731;background:#fff;margin:24px auto;max-width:960px;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #d5dbe0;padding-bottom:4px}h3{font-size:15px;margin:18px 0 4px}
.meta,.counts,.said,.note{color:#4f5b66;font-size:13px}.said{color:#8a4b00}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #e6eaee}th{font-size:12px;color:#4f5b66}
tr.open td,tr.pending td{background:#fff6e5}tr.ai td:last-child{color:#5b3fb5}tr.you td:last-child,tr.edited td:last-child,tr.changed td:last-child{color:#0b5cad}
</style></head><body>
<h1>Quote summary: ${esc(s.client.name)}</h1>
<p class="meta">${[s.client.state, s.client.fileName, `Saved ${when}`, s.version ? `Rater Autofill ${s.version}` : null].filter(Boolean).map(esc).join(' · ')}</p>
<p class="meta">${s.answers} answer${s.answers === 1 ? '' : 's'} in · ${s.open} left for the agent · ${s.marked.length} marked done without an answer. Nothing was submitted or bound by the extension.</p>
${list('Your overrides', s.overrides, (r) => `${where(r) ? `${where(r)}: ` : ''}<b>${esc(r.label)}</b>: ${esc(r.value)} <span class="note">(${esc(r.said)})</span>`)}
${list('AI decisions', s.ai, (r) => `${where(r)}: <b>${esc(r.label)}</b>: ${esc(r.value)} <span class="note">(${esc(r.sourceSaid)}${r.note ? `. ${esc(r.note)}` : ''})</span>`)}
${list('Marked done without an answer', s.marked, (r) => `${where(r)}: <b>${esc(r.label)}</b>${r.note ? ` <span class="note">(${esc(r.note)})</span>` : ''}`)}
${pages || '<p>No page of this quote has been filled yet.</p>'}
</body></html>
`;
}

// A file name for the summary: the client's name, then the day and time it was saved.
function summaryFileName(s) {
  const slug = String(s.client.name ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
  return `quote-summary-${slug}-${s.at.slice(0, 16).replace(/[T:]/g, '-')}.html`;
}

// Save summary: the HTML file in Downloads (as captures and recordings are saved). Returns its name.
function downloadSummary(s) {
  const name = summaryFileName(s);
  const url = URL.createObjectURL(new Blob([summaryHtml(s)], { type: 'text/html' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

// The summary as the panel has it now: the reports of the tabs still open, the intake and its
// corrections, the quote states the agent kept.
function summaryNow() {
  return quoteSummary({ reports: state.reports, intake: state.intake, quoteStates: state.quoteStates, intakeId: usage.currentSession()?.intakeId ?? null,
    version: usage.build().version });
}

// Quote summary, from the Quote done dock or the client strip: the sheet over the panel, made from
// what the panel holds as it opens. Focus goes into it and back where it was when it closes.
function openSummary() {
  if (!state.intake) return;
  if (!state.summary) state.summaryReturn = document.activeElement;
  flushSync(() => {
    state.detailsOpen = false;
    state.summary = { summary: summaryNow(), saved: null };
  });
  showScreen();
  $('summary-close')?.focus();
}
function closeSummary() {
  if (!state.summary) return;
  state.summary = null;
  showScreen();
  const back = state.summaryReturn;
  state.summaryReturn = null;
  (back?.isConnected ? back : $('quote-summary'))?.focus();
}

// Save summary: the summary shown, as an HTML file in Downloads.
function saveSummary() {
  const open = state.summary;
  if (!open) return;
  try {
    const name = downloadSummary(open.summary);
    state.summary = { ...open, saved: `Saved ${name} to Downloads. It holds the client’s answers: keep it as you keep their file.` };
  } catch (e) {
    state.summary = { ...open, saved: `Couldn’t save the summary: ${e?.message ?? e}` };
  }
}

export { SOURCES, closeSummary, openSummary, saveSummary, downloadSummary, quoteSummary, summaryFileName, summaryHtml, summaryRow };
