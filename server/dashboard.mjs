// The maintainer's live usage page (GET /dashboard on the usage server, server/index.mjs): the
// last 24 hours, 7 and 30 days of the events this server stored, in plain server-rendered HTML
// that reloads itself every minute. Behind RATER_DASHBOARD_TOKEN (HTTP Basic, any user name, the
// token as the password); without it the page is off (docs/hosting.md).
//
// The numbers use the review scripts' definitions (scripts/lib/events.mjs, scripts/lib/signals.mjs),
// copied here because the deployed server has no scripts/ (server/Dockerfile); a test keeps them
// in step (test/dashboard.test.mjs). A period is when the server received the events. Per quote:
// a page filled twenty times counts once. Test runs (an intake marked as a test, or one of
// RATER_TEST_INTAKES' fingerprints) are left out unless the page is asked for them (?tests=1).
// The events are already redacted by the extension and cleaned by the server: the page shows
// what they hold (initials, state, business class, redacted labels and reports), nothing more.

import fs from 'node:fs';
import path from 'node:path';

export const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 };
export const MIN_DASHBOARD_TOKEN = 16;
const DAY = 24 * 60 * 60 * 1000;
const RECENT_ROWS = 40;
const LIST_ROWS = 30;

const receivedAt = (e) => e.receivedAt ?? e.t ?? '';
const isCarrierEvent = (e) => !!e.carrier && e.carrier !== 'test';

// The quotes: intakes loaded in a session that worked on a carrier's page (events.mjs quoteSessions).
export function quoteSessions(events) {
  const onCarrier = new Set(events.filter((e) => isCarrierEvent(e) && e.session).map((e) => e.session));
  return new Set(events.filter((e) => e.type === 'intake_loaded' && onCarrier.has(e.session)).map((e) => e.session));
}

// Test runs (signals.mjs testSessionsOf): an intake loaded as one or listed by fingerprint (full or
// leading hex), then the agent's latest mark in the panel.
export function testSessions(events, testIntakes = []) {
  const listed = testIntakes.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const listedTest = (e) => !!e.intakeId && listed.some((id) => String(e.intakeId).toLowerCase().startsWith(id));
  const out = new Set(events.filter((e) => e.type === 'intake_loaded' && e.session && (e.test === true || listedTest(e))).map((e) => e.session));
  const marks = new Map();
  for (const e of events) if (e.type === 'intake_marked' && e.session) marks.set(e.session, e.test === true);
  for (const [session, test] of marks) (test ? out.add(session) : out.delete(session));
  return out;
}

// RATER_TEST_INTAKES: fingerprints separated by commas, spaces or new lines, each at least 8 hex
// characters (as reviews/test-intakes.txt); anything else is ignored, so a typo hides no quote.
export const testIntakesFrom = (raw) => String(raw ?? '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{8,64}$/.test(x));

// The events the review would read (loadEvents): no local test page, no blank pages, "-Reload"
// pages merged, in time order.
export function prepare(events) {
  const all = events.map((e) => ({ ...e, page: e.page ? String(e.page).replace(/-Reload$/, '') : e.page })).filter((e) => e.page !== 'blank');
  const onTest = new Set(all.filter((e) => e.carrier === 'test' && e.session).map((e) => e.session));
  const onCarrier = new Set(all.filter((e) => isCarrierEvent(e) && e.session).map((e) => e.session));
  return all.filter((e) => e.carrier !== 'test' && !(onTest.has(e.session) && !onCarrier.has(e.session)))
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

const pageOf = (e) => `${e.page ?? '?'}${e.step ? ` › ${e.step}` : ''}`;
const buildOf = (e) => `${e.v ?? '?'} ${e.channel ?? '?'}`;
// One answer of one quote (signals.mjs filledOnce), and one page of one quote.
const answerKey = (e) => `${e.session}|${e.page}|${e.view ?? ''}|${e.key ?? e.q ?? ''}|${e.label ?? ''}`;
const pageKey = (e) => `${e.session}|${e.carrier}|${pageOf(e)}|${e.view ?? ''}`;
const agentChange = (e) => e.type === 'field_change' && e.by === 'agent';

// The fixed numbers of a set of events (one period, test runs already in or out).
function counts(live, quotes) {
  const started = new Set(live.filter((e) => e.type === 'intake_loaded' && quotes.has(e.session)).map((e) => e.session));
  const auto = live.filter((e) => agentChange(e) && e.autofilled);
  return {
    quotes: started.size,
    pagesFilled: new Set(live.filter((e) => e.type === 'fill_run' && e.filled > 0).map(pageKey)).size,
    answersFilled: new Set(live.filter((e) => e.type === 'fill_field' && e.result === 'filled').map(answerKey)).size,
    // Another value or cleared (signals.mjs `corrected`); reformatted apart; and answers the agent
    // gave where autofill gave none.
    corrected: auto.filter((e) => e.vsAutofill === 'different' || e.vsAutofill === 'cleared').length,
    reformatted: auto.filter((e) => e.vsAutofill === 'format').length,
    byHand: live.filter((e) => agentChange(e) && !e.autofilled).length,
    problems: live.filter((e) => e.type === 'problem_report').length,
    unfamiliar: new Set(live.filter((e) => e.type === 'fill_field' && e.result === 'unfamiliar').map((e) => `${e.carrier}|${e.page}|${e.label ?? ''}`)).size,
  };
}

// The same numbers per agent, carrier or build: rows sorted by quotes, then events.
function breakdown(live, quotes, keyOf) {
  const groups = new Map();
  for (const e of live) {
    const k = keyOf(e);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  // A quote started in the period counts under a key when one of its events there has that key
  // (its carrier's events for a carrier, as an intake has none; its own for an agent or build).
  const started = new Set(live.filter((e) => e.type === 'intake_loaded' && quotes.has(e.session)).map((e) => e.session));
  return [...groups].map(([key, list]) => ({
    key, ...counts(list, quotes),
    quotes: new Set(list.filter((e) => started.has(e.session)).map((e) => e.session)).size,
    last: list.reduce((m, e) => (receivedAt(e) > m ? receivedAt(e) : m), ''),
  })).sort((a, b) => b.quotes - a.quotes || b.answersFilled - a.answersFilled || a.key.localeCompare(b.key));
}

/**
 * What the page shows.
 * @param {object[]} stored  the stored events (any order), at least the last 30 days received
 * @param {{now?: number, window?: string, includeTests?: boolean, testIntakes?: string[]}} opts
 *   window: one of WINDOWS for the breakdowns and lists (the totals show every window)
 */
export function summarize(stored, { now = Date.now(), window = '7d', includeTests = false, testIntakes = [] } = {}) {
  const all = prepare(stored);
  const quotes = quoteSessions(all);
  const tests = testSessions(all, testIntakes);
  const since = (days) => new Date(now - days * DAY).toISOString();
  const period = (days) => all.filter((e) => receivedAt(e) >= since(days));
  const keep = (list) => (includeTests ? list : list.filter((e) => !tests.has(e.session)));
  const leftOut = (list) => new Set(list.filter((e) => e.type === 'intake_loaded' && tests.has(e.session) && quotes.has(e.session)).map((e) => e.session)).size;

  const totals = Object.entries(WINDOWS).map(([name, days]) => {
    const inPeriod = period(days);
    return { window: name, ...counts(keep(inPeriod), quotes), testRuns: leftOut(inPeriod) };
  });
  const live = keep(period(WINDOWS[window] ?? WINDOWS['7d']));
  const newest = (list) => [...list].sort((a, b) => receivedAt(b).localeCompare(receivedAt(a)) || String(b.t).localeCompare(String(a.t)));
  const test = (e) => tests.has(e.session);

  const activity = newest(live.filter((e) => ['intake_loaded', 'fill_run', 'fill_error', 'problem_report'].includes(e.type))).slice(0, RECENT_ROWS).map((e) => ({
    t: e.t, agent: e.agent ?? null, build: buildOf(e), test: test(e), carrier: e.carrier ?? null, page: e.page ? pageOf(e) : null,
    what: e.type === 'intake_loaded' ? (quotes.has(e.session) ? 'Quote started' : 'Intake loaded (no carrier page yet)')
      : e.type === 'fill_run' ? `${e.auto ? 'Auto fill' : 'Fill'}: ${e.filled ?? 0} filled`
      + `${e.failed ? `, ${e.failed} failed` : ''}${e.leftRequired ? `, ${e.leftRequired} required left` : ''}${e.unknown ? `, ${e.unknown} unfamiliar` : ''}`
      + `${e.advanced ? ', continued' : ''}${e.pageChanged ? ' · page changed?' : ''}`
      : e.type === 'fill_error' ? `Fill error: ${String(e.error ?? '').slice(0, 120)}` : 'Problem report',
    detail: e.type === 'intake_loaded' ? [e.state, e.businessClass, e.counts ? `${e.counts.vehicles ?? 0} vehicles, ${e.counts.drivers ?? 0} drivers` : null].filter(Boolean).join(' · ') : '',
  }));

  const problems = newest(live.filter((e) => e.type === 'problem_report')).slice(0, LIST_ROWS).map((e) => ({
    t: e.t, agent: e.agent ?? null, build: `${buildOf(e)}${e.commit ? ` ${e.commit}` : ''}`, test: test(e), carrier: e.carrier ?? null, page: e.page ? pageOf(e) : null,
    text: String(e.text ?? '').trim(), blockers: Array.isArray(e.blockerList) ? e.blockerList : [],
  }));

  // Questions no rule knew (fill_field `unfamiliar`), once per carrier, page and label, newest first.
  const unknown = new Map();
  for (const e of live) {
    if (e.type !== 'fill_field' || e.result !== 'unfamiliar') continue;
    const k = `${e.carrier}|${e.page}|${e.label ?? ''}`;
    const u = unknown.get(k) ?? { carrier: e.carrier ?? null, page: e.page ? pageOf(e) : null, label: e.label ?? '', controlKind: e.controlKind ?? null, seen: 0, quotes: new Set(), last: '' };
    u.seen++;
    if (e.session) u.quotes.add(e.session);
    if (receivedAt(e) > u.last) u.last = receivedAt(e);
    unknown.set(k, u);
  }
  return {
    now: new Date(now).toISOString(), window, includeTests,
    totals,
    agents: breakdown(live, quotes, (e) => e.agent ?? null),
    carriers: breakdown(live, quotes, (e) => (isCarrierEvent(e) ? e.carrier : null)),
    builds: breakdown(live, quotes, (e) => (e.v || e.channel ? buildOf(e) : null)),
    activity,
    problems,
    unknown: [...unknown.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, LIST_ROWS).map((u) => ({ ...u, quotes: u.quotes.size })),
  };
}

// The stored events received in the last `days` days (by file, one per UTC day). Day files only
// grow, so each is parsed again only when its size changed.
export function eventReader(eventsDir) {
  const cache = new Map();
  return (days, now = Date.now()) => {
    const first = new Date(now - days * DAY).toISOString().slice(0, 10);
    const files = fs.readdirSync(eventsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= first).sort();
    for (const f of cache.keys()) if (!files.includes(f)) cache.delete(f);
    return files.flatMap((f) => {
      const full = path.join(eventsDir, f);
      const size = fs.statSync(full).size;
      if (cache.get(f)?.size !== size) {
        const events = fs.readFileSync(full, 'utf8').split('\n').flatMap((line) => {
          if (!line) return [];
          try { return [JSON.parse(line)]; } catch { return []; }
        });
        cache.set(f, { size, events });
      }
      return cache.get(f).events;
    });
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (iso) => (iso ? esc(String(iso).slice(0, 16).replace('T', ' ')) : '—');
const testTag = (x) => (x.test ? ' <span class="tag">test</span>' : '');
const table = (head, rows, empty = 'None.') => (rows.length
  ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<p class="muted">${empty}</p>`);
const NUMBERS = [['quotes', 'Quotes started'], ['pagesFilled', 'Pages filled'], ['answersFilled', 'Answers filled'], ['corrected', 'Autofill answers changed'],
  ['reformatted', 'Reformatted'], ['byHand', 'Answered by hand'], ['problems', 'Problem reports'], ['unfamiliar', 'Unfamiliar questions']];

/** The page for summarize()'s result. */
export function renderDashboard(s, { refreshSeconds = 60 } = {}) {
  const link = (over) => {
    const q = new URLSearchParams({ window: over.window ?? s.window, ...((over.includeTests ?? s.includeTests) ? { tests: '1' } : {}) });
    return `?${q}`;
  };
  const per = (rows, name) => table([name, 'Quotes', 'Pages filled', 'Answers filled', 'Changed', 'By hand', 'Problems', 'Last event'],
    rows.map((r) => [esc(r.key), r.quotes, r.pagesFilled, r.answersFilled, r.corrected, r.byHand, r.problems, when(r.last)]));
  const testRuns = s.totals.map((t) => `${t.window} ${t.testRuns}`).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}"><meta name="robots" content="noindex">
<title>Rater usage</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#e3e3e6;--card:#f6f6f8;--accent:#0b63ce;--tag:#fde7c3}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#ececef;--muted:#9a9aa2;--line:#2c2c31;--card:#1c1c20;--accent:#6aa8ff;--tag:#5a4317}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
a{color:var(--accent)}.muted{color:var(--muted)}.tag{background:var(--tag);border-radius:4px;padding:0 5px;font-size:12px}
nav{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 16px}nav b{font-weight:600}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
.totals td:not(:first-child),.totals th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
pre{white-space:pre-wrap;margin:0;font:inherit}
</style></head><body><main>
<h1>Rater Autofill usage</h1>
<p class="muted">As of ${when(s.now)} UTC, by when the server received the events · reloads every minute · test runs ${s.includeTests ? '<b>included</b>' : 'left out'} (quotes marked as a test: ${esc(testRuns)})</p>
<nav>${Object.keys(WINDOWS).map((w) => (w === s.window ? `<b>${w}</b>` : `<a href="${esc(link({ window: w }))}">${w}</a>`)).join('')}
<span class="muted">|</span><a href="${esc(link({ includeTests: !s.includeTests }))}">${s.includeTests ? 'Leave test runs out' : 'Include test runs'}</a></nav>
<h2>Totals</h2>
<div class="scroll"><table class="totals"><thead><tr><th></th>${s.totals.map((t) => `<th>${esc(t.window)}</th>`).join('')}</tr></thead><tbody>
${NUMBERS.map(([k, name]) => `<tr><td>${name}</td>${s.totals.map((t) => `<td>${t[k]}</td>`).join('')}</tr>`).join('\n')}
</tbody></table></div>
<p class="muted">Per quote: a page or answer filled again counts once. Changed: an autofilled answer the agent set to another value or cleared. By hand: an answer the agent gave where autofill gave none.</p>
<h2>Per agent (${esc(s.window)})</h2>${per(s.agents, 'Agent')}
<h2>Per carrier (${esc(s.window)})</h2>${per(s.carriers, 'Carrier')}
<h2>Per version and channel (${esc(s.window)})</h2>${per(s.builds, 'Build')}
<h2>Recent activity (${esc(s.window)}, newest first)</h2>
${table(['When (UTC)', 'Agent', 'Build', 'Carrier', 'Page', 'What'], s.activity.map((a) => [when(a.t), esc(a.agent ?? '—') + testTag(a), esc(a.build), esc(a.carrier ?? '—'), esc(a.page ?? '—'),
  `${esc(a.what)}${a.detail ? `<div class="muted">${esc(a.detail)}</div>` : ''}`]))}
<h2>Problem reports (${esc(s.window)}, newest first)</h2>
${table(['When (UTC)', 'Agent', 'Build', 'Where', 'Report'], s.problems.map((p) => [when(p.t), esc(p.agent ?? '—') + testTag(p), esc(p.build), esc([p.carrier, p.page].filter(Boolean).join(' ') || '—'),
  `<pre>${esc(p.text)}</pre>${p.blockers.length ? `<div class="muted">Held by: ${esc(p.blockers.join('; '))}</div>` : ''}`]))}
<h2>Unfamiliar questions (${esc(s.window)}, newest first)</h2>
<p class="muted">Questions a fill met that no rule knew, once per carrier, page and label.</p>
${table(['Last seen (UTC)', 'Carrier', 'Page', 'Question', 'Kind', 'Seen', 'Quotes'], s.unknown.map((u) => [when(u.last), esc(u.carrier ?? '—'), esc(u.page ?? '—'), esc(u.label), esc(u.controlKind ?? ''), u.seen, u.quotes]))}
</main></body></html>`;
}
