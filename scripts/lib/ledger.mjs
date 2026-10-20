// The weekly review's ledger read back (step 2 of .claude/skills/weekly-review): each item line of
// the open `weekly-review` issue, the fix that closed it, which builds in the usage log contain that
// fix, and what the period's events from those builds say about it, with the weekly numbers set
// against the ledger's.
//
// A reporter only: it proposes verified / recurred / not exercised from counts; the reviewer
// decides and updates the ledger. scripts/ledger.mjs asks gh and git; nothing here writes anywhere.

import { spawnSync } from 'node:child_process';
import { receivedAt } from './daily.mjs';

// ---------- the ledger's text ----------

// An item line: a list item opening with its ID and a middle dot, its checkbox ticked once closed.
// Headings ("### W42-13 · …"), table rows and a spot review's "- W42-01, -03: verified" aren't items.
const ITEM_LINE = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(W\d{2}-\d{2,})\s+·\s+(.*)$/;
const TYPE = /^(Fix|Decide|Capture|Watch|Drop)\b/i;
const PRS = /^PRs?\s+(#\d+(?:\s*(?:,|and|&|\+)\s*#\d+)*)/i;
const STATUS = /^(PR open\b|merged\b|released in\b)/i;

/**
 * One ledger line: `- [ ] W42-03 · S2 · Fix · <title> · <decision> · PR #77 · merged 64dd051 ·
 * signature: <signature>`. Severity and type may be missing (a dropped item); the signature is the
 * last field and may hold dots of its own.
 */
export function parseItemLine(line) {
  const m = ITEM_LINE.exec(line);
  if (!m) return null;
  const [, box, id, rest] = m;
  const at = rest.search(/\bsignature:/i);
  const head = (at < 0 ? rest : rest.slice(0, at)).replace(/[\s·]+$/, '');
  const parts = head.split(/\s+·\s+/).map((p) => p.trim()).filter(Boolean);
  let i = 0;
  const severity = /^S[1-4]$/.test(parts[i] ?? '') ? parts[i++] : null;
  const type = TYPE.test(parts[i] ?? '') ? parts[i++] : null;
  const title = parts[i++] ?? '';
  const prs = [];
  const status = [];
  const decision = [];
  for (const p of parts.slice(i)) {
    const pr = PRS.exec(p);
    if (pr) for (const [, n] of pr[1].matchAll(/#(\d+)/g)) prs.push(Number(n));
    else if (STATUS.test(p)) status.push(p);
    else decision.push(p.replace(/\*\*/g, ''));
  }
  const all = status.join(' ');
  return {
    id,
    ticked: box === 'x' || box === 'X',
    severity,
    type,
    title,
    decision: decision.join(' · '),
    prs: [...new Set(prs)],
    merged: /\bmerged\s+([0-9a-f]{7,40})\b/i.exec(all)?.[1] ?? null,
    released: /\breleased in\s+v?(\d+\.\d+\.\d+)/i.exec(all)?.[1] ?? null,
    signature: at < 0 ? null : parseSignature(rest.slice(at + 'signature:'.length)),
  };
}

// The "Weekly numbers" table: its column name (W42) and each number's first value column.
function numbersTable(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^#{2,3}\s+Weekly numbers/i.test(l));
  if (start < 0) return null;
  const rows = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(l)) break;
    if (!/^\s*\|/.test(l)) { if (rows.length) break; continue; }
    const cells = l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  if (!rows.length) return null;
  const [header, ...data] = rows;
  return { column: header[1] ?? 'Last period', values: Object.fromEntries(data.map((r) => [r[0], r[1] ?? ''])) };
}

/**
 * The ledger issue: title, period (from a title "Weekly review W42 (2026-10-06 – 2026-10-13)"),
 * weekly numbers and item lines. `comments`: item lines there (a spot review's) are kept apart; the
 * body is the ledger, comments are history.
 */
export function parseLedger(body, { title = '', comments = [] } = {}) {
  const text = String(body ?? '');
  const items = text.split('\n').map(parseItemLine).filter(Boolean);
  const inBody = new Set(items.map((x) => x.id));
  const fromComments = new Map();
  for (const c of comments) {
    for (const x of String(c ?? '').split('\n').map(parseItemLine).filter(Boolean)) if (!inBody.has(x.id)) fromComments.set(x.id, { ...x, inComment: true });
  }
  const dates = /\((\d{4}-\d{2}-\d{2})\s*[–-]\s*(\d{4}-\d{2}-\d{2})\)/.exec(title);
  return {
    title,
    week: /\bW\d{2}\b/.exec(title)?.[0] ?? null,
    period: dates ? { from: dates[1], to: dates[2] } : null,
    numbers: numbersTable(text),
    items: [...items, ...fromComments.values()],
  };
}

// ---------- signatures ----------

// A structured signature names what to count: `<expect|symptom> <event type|*> [field op value]…
// [when <event type|*> [field op value]…]`, op one of = != ~ > <. `field=*` is present, `field!=*`
// absent, `~` a case-insensitive substring or /regex/; a value with spaces goes in double quotes;
// fields may be dotted (platform.os). `expect`: the fix makes the event appear; `symptom`: the
// event shows the problem. Several patterns: each in its own backticks, or separated by `;`.
const KIND = /^(expect|symptom)\s/;
const COND = /^([A-Za-z_][\w.]*)(!=|=|~|>|<)(.*)$/;
// Where a symptom happens: its exact conditions on these fields make its default scenario.
const WHERE = new Set(['carrier', 'page', 'step', 'view', 'key', 'q', 'label']);
// A free-text signature's countable part: event types in backticks (`client_error`, `fill_field.source`).
const EVENT_TOKEN = /^([a-z]+(?:_[a-z]+)+)(?:\.([A-Za-z][\w.]*))?$/;

function tokenize(src) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (const ch of src) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (quoted) throw new Error(`unclosed quote in "${src}"`);
  if (cur || any) out.push(cur);
  return out;
}

function condition(token, src) {
  const m = COND.exec(token);
  if (!m || m[3] === '') throw new Error(`"${token}" in "${src}" isn't field=value, field!=value, field~text, field>n or field<n`);
  const [, path, op, value] = m;
  if ((op === '>' || op === '<') && !Number.isFinite(Number(value))) throw new Error(`"${token}" in "${src}" compares with a number`);
  const re = op === '~' ? /^\/(.+)\/([a-z]*)$/.exec(value) : null;
  return { path, op, value, re: re ? new RegExp(re[1], re[2].replace(/g/g, '') || 'i') : null };
}

function clause(tokens, src) {
  const [type, ...conds] = tokens;
  if (!type || !/^(\*|[a-z][a-z_]*)$/.test(type)) throw new Error(`no event type in "${src}"`);
  return { type, conds: conds.map((t) => condition(t, src)) };
}

/** One structured pattern: `symptom fill_field page=AddDriver result=failed label~license`. */
export function parsePattern(src) {
  const text = String(src).trim();
  const tokens = tokenize(text);
  const kind = tokens.shift();
  if (kind !== 'expect' && kind !== 'symptom') throw new Error(`a signature opens with expect or symptom: "${text}"`);
  const w = tokens.indexOf('when');
  return { kind, ...clause(w < 0 ? tokens : tokens.slice(0, w), text), when: w < 0 ? null : clause(tokens.slice(w + 1), text), text };
}

/**
 * A ledger signature, structured or free text (both accepted). Free text is counted by the event
 * types it names in backticks, read as presence (`free`); anything else in it is the reviewer's.
 */
export function parseSignature(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  let sources = spans.filter((s) => KIND.test(s));
  if (!sources.length && KIND.test(text)) sources = text.replace(/`/g, '').split(/\s*;\s*/).filter(Boolean);
  if (sources.length) {
    try {
      return { text, structured: true, patterns: sources.map(parsePattern), error: null };
    } catch (err) {
      return { text, structured: true, patterns: [], error: err.message };
    }
  }
  const patterns = [];
  for (const s of spans) {
    const m = EVENT_TOKEN.exec(s);
    if (m) patterns.push({ kind: 'expect', type: m[1], conds: m[2] ? [{ path: m[2], op: '=', value: '*', re: null }] : [], when: null, text: s, free: true });
  }
  return { text, structured: false, patterns, error: null };
}

const valueAt = (e, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), e);
const present = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
const asText = (x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : String(x));
const isNumber = (x) => x != null && x !== '' && typeof x !== 'object' && Number.isFinite(Number(x));

function holds(c, e) {
  const v = valueAt(e, c.path);
  if (c.value === '*' && (c.op === '=' || c.op === '!=')) return present(v) === (c.op === '=');
  const vals = (Array.isArray(v) ? v : [v]).filter((x) => x != null);
  switch (c.op) {
    case '=': return vals.some((x) => asText(x) === c.value);
    case '!=': return !vals.some((x) => asText(x) === c.value);
    case '~': return vals.some((x) => (c.re ? c.re.test(asText(x)) : asText(x).toLowerCase().includes(c.value.toLowerCase())));
    case '>': return vals.some((x) => isNumber(x) && Number(x) > Number(c.value));
    case '<': return vals.some((x) => isNumber(x) && Number(x) < Number(c.value));
    default: return false;
  }
}

/** Whether event `e` is one the clause describes. */
export const matches = (cl, e) => (cl.type === '*' || e.type === cl.type) && cl.conds.every((c) => holds(c, e));

// Where a pattern's scenario is reached: its `when`; for a symptom without one, the same event
// type on the same carrier, page, step and question (its exact conditions on those fields); an
// expected event without `when` has none (not seeing it means not exercised).
export function scenarioOf(p) {
  if (p.when) return p.when;
  if (p.kind !== 'symptom') return null;
  return { type: p.type, conds: p.conds.filter((c) => WHERE.has(c.path) && c.op === '=' && c.value !== '*') };
}

// ---------- builds and fixes ----------

/** Compare versions numerically ("0.9.10" after "0.9.9"). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/**
 * A fix as builds can be checked against it: its commits (merge commits on main), the manifest
 * version at the newest of them, and the first manifest version after all of them on main (the
 * release that carries it; null while unreleased).
 * @param {string[]} commits
 * @param {{versionAt: (c: string) => string|null, releaseAfter: (c: string) => string|null}} git
 */
export function fixOf(commits, git) {
  if (!commits.length) return null;
  const versions = commits.map((c) => git.versionAt(c));
  const releases = commits.map((c) => git.releaseAfter(c));
  const max = (xs) => (xs.some((x) => !x) ? null : xs.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)));
  return { commits, version: max(versions), release: max(releases) };
}

/**
 * Does a build contain the fix? 'yes', 'no' or 'unknown'. A build with a commit (since 0.9.9;
 * `+dirty`: uncommitted changes on top) contains fix commit F when F is its ancestor; a commit this
 * clone doesn't have, or a build with only a version, is placed by version: at least the first
 * manifest version after F contains it, below F's own version doesn't, F's version itself can't tell
 * (a development copy before the release bump).
 * @param {{version?: string|null, commit?: string|null}} build
 * @param {{isAncestor: (a: string, b: string) => boolean|null}} git  null: a commit it doesn't know
 */
export function buildContains(build, fix, git) {
  if (!fix?.commits?.length) return 'no';
  const commit = build.commit ? String(build.commit).replace(/\+dirty$/, '') : null;
  if (commit) {
    const known = fix.commits.map((f) => git.isAncestor(f, commit));
    if (known.every((x) => x === true)) return 'yes';
    if (known.some((x) => x === false)) return 'no';
  }
  if (!build.version || build.version === '?') return 'unknown';
  if (fix.release && compareVersions(build.version, fix.release) >= 0) return 'yes';
  if (fix.version && compareVersions(build.version, fix.version) < 0) return 'no';
  return 'unknown';
}

export const buildKey = (e) => `${e.v ?? '?'}|${e.channel ?? '?'}|${e.commit ?? ''}`;
export const buildName = (e) => `${e.v ?? '?'} ${e.channel ?? '?'}${e.commit ? ` ${String(e.commit).slice(0, 7)}${String(e.commit).endsWith('+dirty') ? '+dirty' : ''}` : ''}`;

/**
 * git as the ledger needs it, in `cwd` (a clone of this repository), against `main` (a ref).
 * Each answer is cached; a commit the clone doesn't have answers null.
 */
export function gitReader(cwd, main = 'origin/main') {
  const run = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const memo = (f) => { const m = new Map(); return (...a) => { const k = a.join(' '); if (!m.has(k)) m.set(k, f(...a)); return m.get(k); }; };
  const resolve = memo((c) => { const r = run('rev-parse', '--verify', '--quiet', `${c}^{commit}`); return r.status === 0 ? r.stdout.trim() : null; });
  const isAncestor = memo((a, b) => {
    if (!resolve(a) || !resolve(b)) return null;
    const r = run('merge-base', '--is-ancestor', a, b);
    return r.status === 0 ? true : r.status === 1 ? false : null;
  });
  const versionAt = memo((c) => {
    const r = run('show', `${c}:manifest.json`);
    try { return r.status === 0 ? JSON.parse(r.stdout).version ?? null : null; } catch { return null; }
  });
  const releaseAfter = memo((c) => {
    const at = versionAt(c);
    if (!at) return null;
    const r = run('log', '--reverse', '--ancestry-path', '--format=%H', `${c}..${main}`, '--', 'manifest.json');
    if (r.status !== 0) return null;
    for (const h of r.stdout.split('\n').filter(Boolean)) {
      const v = versionAt(h);
      if (v && compareVersions(v, at) > 0) return v;
    }
    return null;
  });
  return { main, resolve, isAncestor, versionAt, releaseAfter, onMain: (c) => isAncestor(c, main) };
}

// ---------- judging the items ----------

const sessionOf = (e) => e.session ?? e.install ?? e.id;

/**
 * What the period's events say about one pattern, counting quotes (sessions), not events.
 * `containsOf(e)`: 'yes' | 'no' | 'unknown' for the event's build.
 */
export function judgePattern(p, events, containsOf, testSessions = new Set()) {
  const hit = { yes: new Set(), no: new Set(), unknown: new Set() };
  const reached = new Set();
  const scenario = scenarioOf(p);
  for (const e of events) {
    const c = containsOf(e);
    const s = sessionOf(e);
    if (matches(p, e)) hit[c].add(s);
    if (c === 'yes' && scenario && matches(scenario, e)) reached.add(s);
  }
  const fixed = hit.yes;
  const missing = p.kind === 'expect' && p.when ? [...reached].filter((s) => !fixed.has(s)).length : 0;
  let status;
  if (p.kind === 'symptom') status = fixed.size ? 'recurred' : reached.size ? 'verified' : 'not exercised';
  else if (missing) status = 'recurred';
  else status = fixed.size ? 'verified' : 'not exercised';
  return {
    text: p.text,
    kind: p.kind,
    free: !!p.free,
    status,
    quotes: fixed.size,
    tests: [...fixed].filter((s) => testSessions.has(s)).length,
    reached: reached.size,
    missing,
    older: hit.no.size,
    unplaced: hit.unknown.size,
  };
}

/** Patterns' statuses as one: any recurred; all verified; some verified (in part); else not exercised. */
export function combine(statuses) {
  if (!statuses.length) return null;
  if (statuses.includes('recurred')) return 'recurred';
  if (statuses.every((s) => s === 'verified')) return 'verified';
  if (statuses.includes('verified')) return 'verified in part';
  return 'not exercised';
}

/**
 * One item's proposed status and evidence.
 * @param item  parseItemLine's, with `fix` (fixOf, or null) and `prs` details from gh
 * @param events  the period's events
 * @param contains  (event) => 'yes' | 'no' | 'unknown' for this item's fix
 */
export function judgeItem(item, events, contains, testSessions = new Set()) {
  const base = { id: item.id, title: item.title, type: item.type, severity: item.severity, inComment: !!item.inComment, prs: item.prDetails ?? [], fix: item.fix ?? null };
  if (item.ticked) return { ...base, status: 'ticked', note: 'closed in the ledger' };
  if (/\bdropped\b/i.test(item.decision)) return { ...base, status: 'dropped', note: item.decision };
  if (/\bdeferred\b|\bnot approved\b/i.test(item.decision)) return { ...base, status: 'deferred', note: item.decision };
  if (!item.fix) {
    const open = (item.prDetails ?? []).filter((p) => p.state === 'OPEN').map((p) => `#${p.number} open`);
    const offMain = (item.prDetails ?? []).filter((p) => p.state === 'MERGED' && !p.onMain).map((p) => `#${p.number} merged into ${p.base}, not on main`);
    const why = [...open, ...offMain].join(', ') || (/\bDecide\b/i.test(item.type ?? '') && !/\banswer:/i.test(item.decision) ? 'question unanswered' : item.decision || 'no PR');
    return { ...base, status: 'still open', note: why };
  }
  // The builds that logged the period and carry the fix.
  const fixedBuilds = new Map();
  for (const e of events) {
    if (contains(e) !== 'yes') continue;
    const k = buildName(e);
    (fixedBuilds.get(k) ?? fixedBuilds.set(k, new Set()).get(k)).add(sessionOf(e));
  }
  const fixedQuotes = new Set([...fixedBuilds.values()].flatMap((s) => [...s])).size;
  const builds = [...fixedBuilds.keys()];
  if (!fixedBuilds.size) {
    const note = item.fix.release ? `no build with the fix (${item.fix.release} or later) logged this period` : 'merged, in no release yet: only a development copy with its commit carries it';
    return { ...base, status: 'not exercised', note, builds, fixedQuotes };
  }
  const sig = item.signature;
  if (!sig || sig.error || !sig.patterns.length) {
    const note = sig?.error ? `signature not read: ${sig.error}` : sig ? 'free-text signature names no event: check by hand' : 'no signature: check by hand';
    return { ...base, status: 'check by hand', note, builds, fixedQuotes };
  }
  const patterns = sig.patterns.map((p) => judgePattern(p, events, contains, testSessions));
  return { ...base, status: combine(patterns.map((p) => p.status)), free: !sig.structured, patterns, builds, fixedQuotes };
}

// ---------- weekly numbers ----------

export const MIN_TREND_QUOTES = 10;
const LEFT = ['unfamiliar', 'leftRequired', 'noData', 'failed'];
// The numbers the brief tracks week over week, in the brief template's order; `better`: +1 higher
// is better, -1 lower is, 0 neither; `pick`: which number of the ledger's cell (parentheses aside).
export const NUMBERS = [
  { label: 'Quotes (any carrier · per carrier)', match: /^Quotes \(/i, show: (k) => `${k.quotes} · ${k.carrierQuotes}`, n: (k) => k.quotes, better: 0 },
  { label: "Quotes done (reached the carrier's final page)", match: /^Quotes done/i, show: (k) => (k.donePercent == null ? '—' : `${k.donePercent}%`), n: (k) => k.donePercent, better: 1 },
  { label: 'Median minutes for a done quote', match: /^Median minutes/i, show: (k) => `${k.medianMinutesDone ?? '—'}`, n: (k) => k.medianMinutesDone, better: -1 },
  { label: 'Answers filled by the rules, per quote', match: /^Answers filled/i, show: (k) => `${k.filledPerQuote ?? '—'}`, n: (k) => k.filledPerQuote, better: 1 },
  { label: 'Autofilled answers corrected, per 100 filled', match: /^Autofilled answers/i, show: (k) => `${k.correctedPer100Filled ?? '—'} (${k.corrected})`, n: (k) => k.correctedPer100Filled, better: -1 },
  { label: `Left to the agent per quote (${LEFT.join(' / ')})`, match: /^Left to the agent/i, show: (k) => LEFT.map((r) => k.leftPerQuote?.[r] ?? 0).join(' / '), n: (k) => LEFT.reduce((a, r) => a + (k.leftPerQuote?.[r] ?? 0), 0), pick: 'sum', better: -1 },
  { label: 'Problem reports per 10 quotes', match: /^Problem reports/i, show: (k) => `${k.problemReportsPer10Quotes ?? '—'}${k.problemReportsInTestRuns ? ` (plus ${k.problemReportsInTestRuns} in test runs)` : ''}`, n: (k) => k.problemReportsPer10Quotes, better: -1 },
  { label: 'AI requests · error rate', match: /^AI requests/i, show: (k) => `${k.aiRequests} · ${k.aiErrorPercent ?? '—'}%`, n: (k) => k.aiErrorPercent, pick: 1, better: -1 },
  { label: 'Restricted actions by the extension (must be 0)', match: /^Restricted actions/i, show: (k) => `${k.restrictedActions}`, n: (k) => k.restrictedActions, better: -1, zero: true },
];

// The number a ledger cell gives: "46 · 7% (0.9.9: 24 requests, 1 error)" → 7 for pick 1.
export function cellNumber(cell, pick = 0) {
  const nums = [...String(cell ?? '').replace(/\([^)]*\)/g, ' ').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (!nums.length) return null;
  if (pick === 'sum') return Math.round(nums.reduce((a, b) => a + b, 0) * 10) / 10;
  return nums[pick] ?? null;
}

/**
 * This period's weekly numbers (signals' `kpis`) beside the ledger's, with a trend only when both
 * periods have at least MIN_TREND_QUOTES quotes: below that a change is noise.
 */
export function weeklyRows(kpis, previous) {
  const prev = previous?.values ?? {};
  const prevLabel = (row) => Object.keys(prev).find((l) => row.match.test(l));
  const prevQuotes = cellNumber(prev[prevLabel(NUMBERS[0])]);
  const enough = kpis.quotes >= MIN_TREND_QUOTES && prevQuotes != null && prevQuotes >= MIN_TREND_QUOTES;
  const rows = NUMBERS.map((row) => {
    const label = prevLabel(row);
    const before = label == null ? null : cellNumber(prev[label], row.pick ?? 0);
    const now = row.n(kpis);
    let trend = '—';
    if (row.zero && now > 0) trend = 'must be 0';
    else if (now == null || before == null) trend = '—';
    else if (!enough) trend = 'too few quotes';
    else if (now === before) trend = 'same';
    else trend = `${now > before ? 'up' : 'down'}${row.better ? ((now > before) === (row.better > 0) ? ' (better)' : ' (worse)') : ''}`;
    return { label: row.label, now: row.show(kpis), before: label == null ? '—' : prev[label], trend };
  });
  return { column: previous?.column ?? 'Last period', quotes: kpis.quotes, prevQuotes, enough, rows };
}

// ---------- the report ----------

/** Events the period holds: received at or after `since` (as the signals report counts them). */
export const inPeriod = (events, since) => (since ? events.filter((e) => receivedAt(e) >= new Date(since).toISOString()) : events);

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const n = (x, one, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

function evidence(r) {
  const parts = [];
  const merged = r.prs.filter((p) => p.state === 'MERGED' && p.onMain);
  if (merged.length) parts.push(merged.map((p) => `#${p.number} → ${String(p.mergeCommit).slice(0, 7)}`).join(', ') + (r.fix?.release ? `, first in ${r.fix.release}` : ', unreleased'));
  else if (r.fix) parts.push(`${r.fix.commits.map((c) => c.slice(0, 7)).join(', ')}${r.fix.release ? `, first in ${r.fix.release}` : ', unreleased'}`);
  if (r.note) parts.push(r.note);
  if (r.builds?.length) parts.push(`fixed builds: ${r.builds.join(', ')} (${n(r.fixedQuotes, 'quote')})`);
  for (const p of r.patterns ?? []) {
    const tests = p.tests ? `, ${p.tests} test` : '';
    const other = `${p.older ? `; ${p.older} on older builds` : ''}${p.unplaced ? `; ${p.unplaced} on builds that can't be placed` : ''}`;
    if (p.kind === 'symptom') parts.push(`\`${p.text}\`: ${p.quotes} of ${n(p.reached, 'quote')} that reached it${tests}${other}`);
    else if (p.missing) parts.push(`\`${p.text}\`: missing on ${p.missing} of ${n(p.reached, 'quote')}${other}`);
    else parts.push(`\`${p.text}\`: ${n(p.quotes, 'quote')}${tests}${other}`);
  }
  return parts.join(' · ');
}

/** The report as Markdown: the brief's "Last period's decisions" and "Weekly numbers". */
export function markdown(r) {
  const L = [];
  L.push(`# Ledger check: ${r.ledger.title || 'weekly-review ledger'}${r.ledger.number ? ` (#${r.ledger.number})` : ''}`, '');
  L.push(`Events received since ${r.since ? r.since.slice(0, 16).replace('T', ' ') : 'the start'} UTC: ${n(r.quotes, 'quote')}${r.testRunsLeftOut ? `, plus ${n(r.testRunsLeftOut, 'test run')} the weekly numbers leave out (the items' counts keep them, marked "test")` : ''}. Read only: the ledger isn't changed. IDs, builds and counts only, no client data.`, '');
  L.push("## Last period's decisions", '');
  L.push('| ID | Title | Status (proposed) | Evidence |', '| --- | --- | --- | --- |');
  for (const x of r.items) {
    const status = `${x.status}${x.free && x.status !== 'check by hand' ? '?' : ''}`;
    L.push(`| ${x.id}${x.inComment ? '*' : ''} | ${cell(x.title)} | ${status} | ${cell(evidence(x))} |`);
  }
  L.push('', 'Proposed from counts of quotes, for the reviewer to confirm: **verified** (on a build with the fix, the expected event was there, or the scenario ran without the symptom), **recurred** (the symptom on a build with the fix, or the expected event missing where it should be), **not exercised** (no build with the fix reached it). A build contains a fix when its commit descends from the fix\'s merge commit, else when its version is at least the first release after it.');
  if (r.items.some((x) => x.free)) L.push('', '`?`: a free-text signature, read as the presence of the events it names in backticks; write it as `expect …` or `symptom …` to count it exactly.');
  if (r.items.some((x) => x.inComment)) L.push('', '`*`: the line is only in a comment. The issue body is the ledger: move it there.');
  const w = r.weekly;
  L.push('', '## Weekly numbers', '');
  L.push(`| Number | This period (${n(w.quotes, 'quote')}) | ${cell(w.column)}${w.prevQuotes != null ? ` (${n(w.prevQuotes, 'quote')})` : ''} | Trend |`, '| --- | --- | --- | --- |');
  for (const row of w.rows) L.push(`| ${row.label} | ${cell(row.now)} | ${cell(row.before)} | ${row.trend} |`);
  L.push('', w.enough ? 'Trend: this period against the ledger\'s.' : `No trend called: a period has fewer than ${MIN_TREND_QUOTES} quotes.`);
  L.push('', '## Builds this period', '', '| Build | Quotes | Merged fixes it contains |', '| --- | --- | --- |');
  for (const b of r.builds) L.push(`| ${b.name} | ${b.quotes} | ${cell(b.fixes)} |`);
  if (r.notes?.length) L.push('', '## Notes', '', ...r.notes.map((x) => `- ${x}`));
  return `${L.join('\n')}\n`;
}
