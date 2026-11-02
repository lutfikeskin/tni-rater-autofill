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
    // As text: a stored agent or carrier may be any JSON (the upload token is public).
    const raw = keyOf(e);
    if (raw == null) continue;
    const k = String(raw);
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
    ...(e.type === 'fill_run' ? { fill: { auto: !!e.auto, filled: e.filled ?? 0, failed: e.failed ?? 0, leftRequired: e.leftRequired ?? 0, unknown: e.unknown ?? 0, advanced: !!e.advanced, pageChanged: !!e.pageChanged } } : {}),
    kind: e.type === 'intake_loaded' ? (quotes.has(e.session) ? 'quote' : 'intake') : e.type === 'fill_run' ? 'fill' : e.type === 'fill_error' ? 'error' : 'problem',
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
  // Quotes started per UTC day received, the last 30 days (oldest first), for the chart.
  const daily = Array.from({ length: WINDOWS['30d'] }, (_, i) => ({ day: new Date(now - (WINDOWS['30d'] - 1 - i) * DAY).toISOString().slice(0, 10), quotes: 0 }));
  const dayIndex = new Map(daily.map((d, i) => [d.day, i]));
  for (const e of keep(period(WINDOWS['30d']))) {
    if (e.type === 'intake_loaded' && quotes.has(e.session) && dayIndex.has(receivedAt(e).slice(0, 10))) daily[dayIndex.get(receivedAt(e).slice(0, 10))].quotes++;
  }
  return {
    now: new Date(now).toISOString(), window, includeTests,
    totals, daily,
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


// --- The page ------------------------------------------------------------------------------------
// Plain HTML and CSS: the server's policy allows no script, so hovering a bar shows its `title`.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const exact = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : '');
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const CARRIERS = { progressive: 'Progressive', geico: 'GEICO', amwins: 'AmWINS' };
const carrierName = (c) => CARRIERS[c] ?? c ?? '';
const PERIOD_NAMES = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' };
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
// "5 min ago", with the exact time on hover.
function ago(iso, now) {
  if (!iso) return '<span class="muted">—</span>';
  const mins = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  const text = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `<time title="${esc(exact(iso))}">${text}</time>`;
}
const testTag = (x) => (x.test ? ' <span class="tag warn" title="A test run, shown because test runs are included">test</span>' : '');
const badge = (agent) => `<span class="who" title="Agent">${esc(agent ?? '?')}</span>`;
const where = (x) => esc([carrierName(x.carrier), x.page].filter(Boolean).join(' › '));
// A bar as long as its share of the largest value, with the number beside it.
const bar = (n, max, title) => `<span class="barred"><span class="bar" title="${esc(title)}"><span style="width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%"></span></span><b class="num">${fmt(n)}</b></span>`;
const empty = (text) => `<p class="empty">${text}</p>`;

// The figures, with what each means in plain words.
const TILES = [
  ['pagesFilled', 'Pages filled', 'Carrier pages the extension filled at least one answer on (once per quote).'],
  ['answersFilled', 'Answers filled', 'Questions the extension answered from the intake or TNI\'s standards (once per quote).'],
  ['corrected', 'Answers agents changed', 'Answers the extension filled that the agent then set to something else or cleared.'],
  ['byHand', 'Answered by hand', 'Questions the agent answered where the extension left them blank.'],
  ['reformatted', 'Only reformatted', 'Filled answers the agent retyped in another format, same value.'],
];

function renderChart(s) {
  const days = WINDOWS[s.window];
  const max = Math.max(1, ...s.daily.map((d) => d.quotes));
  const bars = s.daily.map((d, i) => {
    const inPeriod = i >= s.daily.length - days;
    return `<span class="col${inPeriod ? ' on' : ''}" title="${esc(d.day)}: ${plural(d.quotes, 'quote')}"><span style="height:${d.quotes ? Math.max(4, Math.round((d.quotes / max) * 100)) : 0}%"></span></span>`;
  }).join('');
  return `<div class="chart"><div class="chart-head"><span>Quotes started per day, last 30 days</span><span class="muted">busiest day: ${plural(max, 'quote')}</span></div>
<div class="cols" role="img" aria-label="Quotes started per day over the last 30 days">${bars}</div>
<div class="chart-foot"><span>${esc(s.daily[0]?.day ?? '')}</span><span>highlighted: ${PERIOD_NAMES[s.window].toLowerCase()}</span><span>today</span></div></div>`;
}

function renderPeople(rows, now) {
  if (!rows.length) return empty('No agent activity in this period.');
  const maxQ = Math.max(...rows.map((r) => r.quotes));
  return `<div class="scroll"><table><thead><tr><th>Agent</th><th class="w">Quotes started</th><th class="r">Answers filled</th><th class="r">Changed by agent</th><th class="r">By hand</th><th class="r">Problem reports</th><th>Last active</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${badge(r.key)}</td><td class="w">${bar(r.quotes, maxQ, `${r.key}: ${plural(r.quotes, 'quote')}`)}</td><td class="r">${fmt(r.answersFilled)}</td><td class="r">${fmt(r.corrected)}</td><td class="r">${fmt(r.byHand)}</td><td class="r">${r.problems ? `<span class="bad">${fmt(r.problems)}</span>` : '0'}</td><td>${ago(r.last, now)}</td></tr>`).join('\n')}
</tbody></table></div>`;
}

function renderShare(rows, nameOf, none) {
  if (!rows.length) return empty(none);
  const max = Math.max(...rows.map((r) => r.quotes));
  return `<ul class="share">${rows.map((r) => `<li><span class="name">${esc(nameOf(r.key))}</span>${bar(r.quotes, max, `${nameOf(r.key)}: ${plural(r.quotes, 'quote')}`)}<span class="muted small">${plural(r.answersFilled, 'answer')} filled</span></li>`).join('')}</ul>`;
}

function activityLine(a) {
  const at = a.page ? ` on <b>${where(a)}</b>` : '';
  if (a.kind === 'quote') return `started a quote${a.detail ? ` <span class="muted">· ${esc(a.detail)}</span>` : ''}`;
  if (a.kind === 'intake') return `loaded an intake <span class="muted">· not on a carrier page yet${a.detail ? ` · ${esc(a.detail)}` : ''}</span>`;
  if (a.kind === 'fill') {
    const f = a.fill;
    const extra = [f.failed && `${fmt(f.failed)} failed`, f.leftRequired && `${fmt(f.leftRequired)} required left to the agent`, f.unknown && `${fmt(f.unknown)} unfamiliar`,
      f.advanced && 'went on to the next page', f.pageChanged && 'the carrier may have changed this page'].filter(Boolean);
    return `${f.auto ? 'auto-filled' : 'filled'} ${plural(f.filled, 'answer')}${at}${extra.length ? ` <span class="muted">· ${esc(extra.join(' · '))}</span>` : ''}`;
  }
  if (a.kind === 'error') return `<span class="bad">hit a fill error</span>${at} <span class="muted">· ${esc(a.what.replace(/^Fill error: /, ''))}</span>`;
  return `<span class="bad">reported a problem</span>${at}`;
}

const STYLE = `
:root{color-scheme:light;--bg:#f4f4f2;--card:#fcfcfb;--fg:#0b0b0b;--fg2:#52514e;--muted:#6f6d67;--line:#e4e3df;--accent:#2a78d6;--accent-soft:#b7d3f6;--track:#eceae6;
  --bad:#c42f2e;--bad-bg:#fbe9e8;--warn:#8a5a00;--warn-bg:#fdf0d2}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#121211;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--muted:#9a988f;--line:#2e2d2b;--accent:#3987e5;--accent-soft:#184f95;--track:#262624;
  --bad:#f08a89;--bad-bg:#3a1d1d;--warn:#f0c26a;--warn-bg:#3a2e14}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#121211;--card:#1a1a19;--fg:#f0efec;--fg2:#c3c2b7;--muted:#9a988f;--line:#2e2d2b;--accent:#3987e5;--accent-soft:#184f95;--track:#262624;
  --bad:#f08a89;--bad-bg:#3a1d1d;--warn:#f0c26a;--warn-bg:#3a2e14}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto}
a{color:var(--accent)}
.muted{color:var(--muted)}.small{font-size:12px}.bad{color:var(--bad);font-weight:600}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:16px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
.sub{margin:2px 0 0;color:var(--fg2)}
.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.seg{display:inline-flex;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px}
.seg a,.seg b{padding:5px 12px;border-radius:999px;text-decoration:none;color:var(--fg2);white-space:nowrap}
.seg a:hover{background:var(--track)}
.seg b{background:var(--accent);color:#fff;font-weight:600}
.pill{display:inline-block;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);text-decoration:none;color:var(--fg2);white-space:nowrap}
.pill:hover{background:var(--track)}
.note{margin:0 0 16px;color:var(--fg2)}
section{margin-top:28px}
h2{font-size:16px;margin:0 0 2px}
.lead{margin:0 0 10px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.hero{display:grid;grid-template-columns:minmax(220px,1fr) 3fr;gap:12px}
.label{font-weight:600;color:var(--fg2)}
.big .value{font-size:56px;font-weight:650;line-height:1.05;letter-spacing:-.02em;margin:6px 0}
.help{margin:0 0 10px;color:var(--muted);font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column}
.tile .value{font-size:32px;font-weight:650;line-height:1.15;margin:4px 0 2px}
.tile .help{flex:1}
.tile.bad{background:var(--bad-bg);border-color:transparent}.tile.bad .label,.tile.bad .value{color:var(--bad)}
.tile.warn{background:var(--warn-bg);border-color:transparent}.tile.warn .label,.tile.warn .value{color:var(--warn)}
.icon{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;color:var(--card);font-size:11px;font-weight:700}
.tile.bad .icon{background:var(--bad)}.tile.warn .icon{background:var(--warn)}
.windows{display:flex;gap:12px;font-size:12px;color:var(--muted)}.windows b{color:var(--fg2);font-weight:600}.windows .cur b{color:var(--accent)}
.chart{display:flex;flex-direction:column;height:100%}
.chart-head,.chart-foot{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
.chart-head span:first-child{font-weight:600;color:var(--fg2);font-size:13px}
.cols{flex:1;min-height:120px;display:flex;align-items:flex-end;gap:2px;margin:10px 0 6px;border-bottom:1px solid var(--line)}
.col{flex:1;height:100%;display:flex;align-items:flex-end}
.col span{display:block;width:100%;background:var(--accent-soft);border-radius:4px 4px 0 0}
.col.on span{background:var(--accent)}
.col:hover span{outline:2px solid var(--fg2)}
.cols2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.cols2 section,.cols2>div{margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
th{font-weight:600;color:var(--muted);font-size:12px;white-space:nowrap}
.r{text-align:right;font-variant-numeric:tabular-nums}.w{min-width:200px}
.barred{display:flex;align-items:center;gap:8px}
.bar{display:inline-block;flex:1;max-width:220px;height:8px;background:var(--track);border-radius:4px;overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent);border-radius:4px}
.num{font-variant-numeric:tabular-nums}
.who{display:inline-grid;place-items:center;min-width:34px;height:26px;padding:0 7px;border-radius:999px;background:var(--track);font-weight:650;font-size:12px;letter-spacing:.03em}
.share{list-style:none;margin:0;padding:0}
.share li{display:grid;grid-template-columns:minmax(90px,1fr) 2fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.share li:last-child{border-bottom:0}.share .name{font-weight:600}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:grid;grid-template-columns:84px 48px 1fr;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}
.feed li:last-child{border-bottom:0}.feed time{color:var(--muted);font-size:12.5px}
.feed .build{display:block;font-size:11.5px;color:var(--muted)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted);margin-right:6px;vertical-align:middle}
.dot.quote{background:var(--accent)}.dot.problem,.dot.error{background:var(--bad)}
.tag{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;vertical-align:middle}
.tag.warn{background:var(--warn-bg);color:var(--warn)}
.reports{display:grid;gap:12px}
.report{border-left:4px solid var(--bad)}
.report .meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--muted);font-size:12.5px;margin-bottom:8px}
.report blockquote{margin:0;white-space:pre-wrap;font-size:14.5px}
.report .held{margin-top:8px;font-size:12.5px;color:var(--fg2)}
.empty{margin:0;padding:18px;text-align:center;color:var(--muted)}
footer{margin-top:36px;color:var(--muted);font-size:12px}
@media (max-width:720px){.hero{grid-template-columns:1fr}.big .value{font-size:48px}.feed li{grid-template-columns:72px 1fr}.feed li>.who{display:none}}
`;

/** The page for summarize()'s result. */
export function renderDashboard(s, { refreshSeconds = 60 } = {}) {
  const link = (over) => `?${new URLSearchParams({ window: over.window ?? s.window, ...((over.includeTests ?? s.includeTests) ? { tests: '1' } : {}) })}`;
  const t = s.totals.find((x) => x.window === s.window) ?? s.totals[0];
  const others = (k) => `<div class="windows">${s.totals.map((x) => `<span${x.window === s.window ? ' class="cur"' : ''}>${esc(x.window)} <b>${fmt(x[k])}</b></span>`).join('')}</div>`;
  const when = (iso) => ago(iso, s.now);
  const tile = ([k, label, help], cls = '') => `<div class="tile${t[k] && cls ? ` ${cls}` : ''}"><div class="label">${t[k] && cls ? '<span class="icon" aria-hidden="true">!</span> ' : ''}${label}</div><div class="value">${fmt(t[k])}</div><p class="help">${help}</p>${others(k)}</div>`;
  const testNote = s.includeTests
    ? 'Test runs are <b>included</b> and marked <span class="tag warn">test</span>.'
    : `Test runs are hidden${t.testRuns ? ` (${plural(t.testRuns, 'test quote')} in this period)` : ''}.`;
  const card = (body) => `<div class="card">${body}</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}"><meta name="robots" content="noindex">
<title>Rater usage</title>
<style>${STYLE}</style></head><body><main>
<header><div><h1>Rater Autofill · live usage</h1>
<p class="sub">Updated ${when(s.now)} (${esc(exact(s.now))}) · refreshes every minute</p></div>
<div class="controls"><nav class="seg" aria-label="Period">${Object.keys(WINDOWS).map((w) => (w === s.window ? `<b>${PERIOD_NAMES[w]}</b>` : `<a href="${esc(link({ window: w }))}">${PERIOD_NAMES[w]}</a>`)).join('')}</nav>
<a class="pill" href="${esc(link({ includeTests: !s.includeTests }))}">${s.includeTests ? 'Hide test runs' : 'Include test runs'}</a></div></header>
<p class="note">${testNote} A quote is an intake the agent took to a carrier's page. Every number counts by when the server received it; the small numbers under each are the other periods.</p>

<section aria-label="Totals"><div class="hero">
<div class="card big"><div class="label">Quotes started</div><div class="value">${fmt(t.quotes)}</div>
<p class="help">${PERIOD_NAMES[s.window]}: intakes loaded and taken to a carrier.</p>${others('quotes')}</div>
${card(renderChart(s))}</div>
<div class="tiles">${TILES.map((x) => tile(x)).join('')}
${tile(['problems', 'Problem reports', 'Reports agents sent from the panel. Read them below.'], 'bad')}
${tile(['unfamiliar', 'Unfamiliar questions', 'Different questions a fill met that no rule knows yet. Listed at the bottom.'], 'warn')}</div></section>

<section><h2>Agents</h2><p class="lead">${PERIOD_NAMES[s.window]}, by the initials each agent set in the panel.</p>
${card(renderPeople(s.agents, s.now))}</section>

<section class="cols2"><div><h2>Carriers</h2><p class="lead">Quotes that reached each carrier.</p>${card(renderShare(s.carriers, carrierName, 'No carrier pages in this period.'))}</div>
<div><h2>Extension versions</h2><p class="lead">Quotes per version and install (store, unpacked, source).</p>${card(renderShare(s.builds, (k) => k, 'No events in this period.'))}</div></section>

<section><h2>Problem reports</h2><p class="lead">Newest first. What the agent wrote, already scrubbed of client details by the panel.</p>
${s.problems.length ? `<div class="reports">${s.problems.map((p) => `<div class="card report"><div class="meta">${badge(p.agent)}${testTag(p)}<span>${when(p.t)}</span><span>· ${where(p) || 'no page'}</span><span>· ${esc(p.build)}</span></div>
<blockquote>${esc(p.text) || '<span class="muted">(no text)</span>'}</blockquote>${p.blockers.length ? `<div class="held">Held up by: ${esc(p.blockers.join(' · '))}</div>` : ''}</div>`).join('\n')}</div>` : card(empty('No problem reports in this period.'))}</section>

<section><h2>Recent activity</h2><p class="lead">The latest quotes, fills and problems, newest first.</p>
${card(s.activity.length ? `<ul class="feed">${s.activity.map((a) => `<li>${when(a.t)}${badge(a.agent)}<div><span class="dot ${a.kind}"></span>${activityLine(a)}${testTag(a)}<span class="build">${esc(a.build)}</span></div></li>`).join('\n')}</ul>` : empty('Nothing yet in this period.'))}</section>

<section><h2>Unfamiliar questions</h2><p class="lead">Questions on carrier pages that no rule answers yet, once per carrier, page and wording. Newest first.</p>
${card(s.unknown.length ? `<div class="scroll"><table><thead><tr><th>Question</th><th>Where</th><th>Kind</th><th class="r">Times seen</th><th class="r">Quotes</th><th>Last seen</th></tr></thead><tbody>
${s.unknown.map((u) => `<tr><td><b>${esc(u.label) || '<span class="muted">(no label)</span>'}</b></td><td>${where(u)}</td><td class="muted">${esc(u.controlKind ?? '')}</td><td class="r">${fmt(u.seen)}</td><td class="r">${fmt(u.quotes)}</td><td>${when(u.last)}</td></tr>`).join('\n')}
</tbody></table></div>` : empty('None in this period.'))}</section>

<footer>Private page for the maintainer. It shows only what the usage events already keep: initials, state, business class, scrubbed labels and reports.</footer>
</main></body></html>`;
}
