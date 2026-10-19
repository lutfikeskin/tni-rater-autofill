// Usage log: what agents do with the extension, recorded so the mappings and rules can be
// improved from real quotes. Recorded without client data:
//  - the intake is identified by a SHA-256 fingerprint of the PDF, never by name or file name;
//  - warnings are logged by code, not by their text (which quotes client details);
//  - dropdown/radio choices are logged as option text (client names redacted); a combo box's
//    value only when it's one of the combo's known options, since the box also takes typed text;
//  - text typed into boxes is never logged. It is compared with the intake on this computer and
//    only the result is kept ("matches drivers[0].dob", "same as autofill except formatting").

export const LOG_KEY = 'usageLog';
export const MAX_EVENTS = 20000;

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// What kind of intake this was, without anything that identifies the client.
export async function intakeSummary(pdfBytes, raw, result) {
  const { record, warnings, stats } = result;
  return {
    intakeId: await sha256Hex(pdfBytes),
    // Changes when TNI edits the intake form's fields.
    formVersion: (await sha256Hex(Object.keys(raw).sort().join('|'))).slice(0, 16),
    answers: stats.filled,
    state: record.garaging?.state ?? null,
    businessClass: record.operations.businessClass,
    vehicleTypes: [...new Set(record.vehicles.map((v) => v.type).filter(Boolean))],
    counts: { drivers: record.drivers.length, vehicles: record.vehicles.length, trailers: record.trailers.length },
    coverages: Object.entries(record.coverage).filter(([, v]) => v === true || v === 'Yes').map(([k]) => k),
    warnings: warnings.map((w) => ({ code: w.code, path: w.path, level: w.level })),
  };
}

// ---------------------------------------------------------------------------------------------
// Comparing values without keeping them

const DATE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeForMatch(v) {
  const s = String(v ?? '').trim();
  let m = s.match(DATE);
  if (m) return `d${m[3]}${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}`;
  m = s.match(ISO_DATE);
  if (m) return `d${m[1]}${m[2]}${m[3]}`;
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "same", "format" (same once spaces/punctuation/case are ignored), "different" or "cleared".
export function compareText(expected, actual) {
  const a = String(expected ?? '').trim();
  const b = String(actual ?? '').trim();
  if (!b) return 'cleared';
  if (a === b) return 'same';
  return normalizeForMatch(a) === normalizeForMatch(b) ? 'format' : 'different';
}

function leaves(obj, prefix = '', out = []) {
  if (obj == null) return out;
  if (Array.isArray(obj)) obj.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  else if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  else if (typeof obj === 'string' || typeof obj === 'number') out.push([prefix, obj]);
  return out;
}

// Which intake fields a typed value equals (after normalizing), e.g. ["drivers[0].dob"].
export function matchIntake(record, typed) {
  const want = normalizeForMatch(typed);
  if (want.length < 3) return [];
  const hits = [];
  for (const [path, value] of leaves(record)) {
    if (path.startsWith('claims.text') || path.startsWith('notes.text')) continue;
    const norm = normalizeForMatch(value);
    if (norm.length >= 3 && norm === want) hits.push(path);
    // Phone and ID numbers are often typed in parts.
    else if (/phone/.test(path) && /^\d{3,4}$/.test(want) && norm.includes(want)) hits.push(`${path}:part`);
  }
  return hits.slice(0, 5);
}

// One word (a name word such as "Ann", or a city) is replaced only as a whole word, so "Ann" leaves
// "Annual" and "Car" leaves "Cargo" alone; any other term (a full name, date of birth, phone, VIN,
// street) is replaced wherever it appears exactly as written. src/content/pagekit.js `capture`
// builds the same patterns.
const ONE_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;
function redactionPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ONE_WORD.test(term) ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu') : new RegExp(escaped, 'gi');
}

export function redactor(terms) {
  const valid = terms.filter((t) => t && t.length >= 3);
  const patterns = valid.map((term) => redactionPattern(term));
  return (s) => (s == null ? s : patterns.reduce((acc, re) => acc.replace(re, '[client]'), String(s)));
}

// ---------------------------------------------------------------------------------------------
// Events

// The computer's system and Chrome's major version, for problems seen on one platform only
// (agents run Windows; the extension is built on a Mac). From navigator.userAgentData where Chrome
// gives it, else the user agent string.
export function platformOf(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent ?? '');
  const data = nav?.userAgentData;
  const brand = data?.brands?.find((b) => /^(Google Chrome|Chromium)$/.test(b.brand))?.version ?? ua.match(/Chrome\/(\d+)/)?.[1];
  const raw = data?.platform || ua.match(/Windows|Mac OS X|CrOS|Android|Linux/)?.[0] || null;
  const os = { 'Mac OS X': 'macOS', CrOS: 'Chrome OS' }[raw] ?? raw;
  const chrome = Number.parseInt(brand ?? '', 10);
  return { os: os ? String(os).slice(0, 20) : null, chrome: Number.isFinite(chrome) ? chrome : null };
}

// The agent dismissed a "needs you" item (its ×: ignore this question and continue): which
// question, why it needed them (`mark`: needs, failed, check, …), keyed like fill events.
export function checkDismissedEvent(x, { redact = (v) => v, keySalt } = {}) {
  return { type: 'check_dismissed', q: x.q ?? null, key: fieldKeyOf(x.key, redact, keySalt), label: redact(x.label || x.name || ''), mark: x.mark ?? null };
}

// The agent's settings, all of them each time (`values`), so the one in force at any moment is the
// last event before it: the filling switches as the panel shows them (defaults: follow-ups and
// Continue on, filling on arrival and replacing answers off), the AI assistant (on, applying
// choices automatically, whether a key is set: never the key), and where usage goes (`central`,
// `other`: a test server, `off`). `reason`: intake (loaded), opened (the panel on a saved
// intake) or changed (`changed` names the setting).
export function agentSettingsEvent(saved = {}, { overwrite = false, reason, changed, centralServer } = {}) {
  const url = saved.serverUrl;
  return {
    type: 'agent_settings', reason, ...(changed ? { changed } : {}),
    values: {
      autoFollowUps: saved.autoFollowUps ?? true, autoAdvance: saved.autoAdvance ?? true, autoPages: saved.autoPages ?? false, overwrite: !!overwrite,
      aiOn: saved.aiOn === true, aiAuto: saved.lunaAuto === true, aiKey: !!saved.lunaKey,
      uploads: url === '' ? 'off' : url === undefined || url === centralServer ? 'central' : 'other',
    },
  };
}

// An error nothing in the panel caught (an exception, a promise nobody awaited): what it said,
// redacted and bounded, and where in the extension's own files it came from (paths inside the
// extension only, never a page's).
const OWN_FRAME = /chrome-extension:\/\/[^/]+\/([\w./-]+:\d+:\d+)/;
export function clientErrorEvent(err, { where, redact = (x) => x } = {}) {
  const message = err?.message ?? (typeof err === 'string' ? err : String(err ?? 'unknown error'));
  const stack = String(err?.stack ?? '').split('\n').map((line) => line.match(OWN_FRAME)?.[1]).filter(Boolean).slice(0, 4);
  return { type: 'client_error', where, error: redact(String(message)).slice(0, 300), ...(stack.length ? { stack } : {}) };
}

// The control, not only its question: a question repeated per vehicle row (`<q>@<row>`) or a
// field without a question id keeps its own key, the same one in fill and change events. A
// data-model name (`ref:<name>`, Duck Creek's) is the carrier's, never the client's, and is kept as
// it is: redacting a name word inside it turned HasContinuousCoverage into "HasContinuousCo[client]ge"
// and split the question (maintainer, 2026-10-13: log quality over redaction). Other keys are
// element ids and names, redacted like prose: a client term only as a whole word (owner_Ann), a
// number or multi-word term wherever it appears; a name word run into an id (driverAnn1) stays. A
// redacted key gets a digest under the quote's secret salt, so `owner_<one name>` and
// `owner_<another>` stay two controls and a guessed name can't be checked; without a salt it's
// left out rather than merged with others.
const DATA_MODEL_KEY = /^ref:[\w.]+(?:@\d+)?$/;
function fieldKeyOf(key, redact, salt) {
  if (!key) return null;
  const raw = String(key);
  if (DATA_MODEL_KEY.test(raw)) return raw;
  const shown = redact(raw);
  if (shown === raw) return raw;
  return salt ? `${shown}#${digest(`${salt}|${raw}`)}` : null;
}

// FNV-1a (32 bits): tells a quote's keys apart; the salt is what keeps it from identifying anyone.
function digest(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Values that look typed rather than picked from a list. If the recorder ever mistakes a typed
// box for a dropdown (date pickers look like dropdowns), these still never reach the log.
const LOOKS_TYPED = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|@|\d{5,}/;

// A combo box (ExtJS) holds whatever is in its box: a pick, or a search the agent typed. Its values
// are choices only when each one is empty or one of the options the fill engine saw for it.
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function isComboPick(change, choices) {
  const options = choices?.get(change.key);
  return [change.before, change.after].every((v) => !oneLine(v) || !!options?.has(oneLine(v)));
}

/**
 * Turns one field change seen on the rater page into a log event.
 * @param {{key, q, label, kind, combo?, before, after, agent}} change  from the page recorder (raw
 *   values); combo: a combo box, whose value may be typed text
 * @param {{record, filled: Map, redact: Function, labels?: Map, choices?: Map, keySalt?: string, step?: string}} ctx
 *   filled: field key -> what autofill put there; labels: field key -> question text as the fill
 *   engine read it (more reliable than the recorder's guess); choices: field key -> Set of a combo's
 *   options as the fill engine saw them; keySalt: the session's (see fieldKeyOf); step: the
 *   step of a one-address application (AmWINS) the recorder read, one of its names (see knownStep)
 */
export function fieldChangeEvent(change, { record, filled, redact, labels, choices, keySalt, step }) {
  const ours = filled.get(change.key) ?? null;
  const typed = (change.combo && !isComboPick(change, choices))
    || LOOKS_TYPED.test(redact(change.before ?? '')) || LOOKS_TYPED.test(redact(change.after ?? ''));
  const kind = change.kind !== 'text' && typed ? 'text' : change.kind;
  const base = {
    type: 'field_change',
    q: change.q ?? null,
    key: fieldKeyOf(change.key, redact, keySalt),
    label: redact(labels?.get(change.key) ?? change.label),
    kind,
    by: change.agent ? 'agent' : 'page',
    autofilled: ours ? ours.path : null,
    ...stepOf(step, redact),
  };
  if (kind === 'text') {
    const before = String(change.before ?? '');
    const after = String(change.after ?? '');
    return {
      ...base,
      change: !before ? 'entered' : !after ? 'cleared' : 'edited',
      vsAutofill: ours ? compareText(ours.shown, after) : undefined,
      matchesIntake: after ? matchIntake(record, after) : [],
    };
  }
  // A confirmed combo value is logged as the option's text.
  const [before, after] = change.combo ? [oneLine(change.before), oneLine(change.after)] : [change.before, change.after];
  return {
    ...base,
    from: redact(before) || null,
    to: redact(after) || null,
    vsAutofill: ours ? (ours.shown === after ? 'same' : 'different') : undefined,
  };
}

// The step of a one-address application (AmWINS: Insured Info, Vehicles, …), whose steps share
// the page's address: pagekit's `stepKey` (the visible headings) on fill events and page layouts,
// the recorder's reading of the same headings on field changes. Only a heading that is one of the
// carrier's own step names (`layoutSteps`) is sent, as that name: a heading can name the insured,
// and the tab may still show the previous client's quote, whose names the loaded intake's
// redaction doesn't know (Codex on PR #65). Absent on carriers whose pages have names of their own (audit 2026-10-08).
export const STEP_MAX = 120;
export function knownStep(carrier, headings) {
  const names = Array.isArray(carrier?.layoutSteps) ? carrier.layoutSteps : [];
  for (const part of String(headings ?? '').split(' / ')) {
    const hit = names.find((name) => name.toLowerCase() === oneLine(part).toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}
// Bounded and redacted as well, though a known step name never needs it.
const stepOf = (step, redact) => (step ? { step: redact(String(step)).slice(0, STEP_MAX) } : {});

// The rule files whose text the `rules` fingerprint of a fill run covers (in this order), so a
// review can tell which mappings and defaults a quote was filled with when a version number spans
// several copies (audit 2026-10-08, finding 7). The panel fetches them from its own package. Every
// module the plan, the record's normalization and the carriers import is here (test/usage.test.mjs
// checks the import graph), since each one changes the answers a fill puts on the page.
export const RULE_FILES = ['src/normalize.js', 'src/rules.js', 'src/plan.js', 'src/schema.js', 'src/util.js', 'src/carriers.js', 'src/carriers/progressive.js', 'src/carriers/amwins.js'];
export async function rulesHash(texts) {
  return (await sha256Hex(texts.join('\n'))).slice(0, 12);
}

// Fill results, minus typed values (text boxes) and client names.
//   run: one fill invocation's id, shared by its fill_run and fill_field events (and a fill_error);
//   rules: the rule files' fingerprint (rulesHash); settings: the panel's filling switches in force
//   ({ autoAdvance, autoFollowUps, autoPages, overwrite }); step: a known step name (knownStep).
export function fillEvents(frames, { carrier, page, view, overwrite, auto = false, ms, redact, keySalt, run, rules, settings, step }) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const isChoice = (x) => x.controlKind && x.controlKind !== 'text';
  const stepField = stepOf(step, redact);
  const events = [{
    type: 'fill_run', carrier, page, view, overwrite, auto, ms,
    ...(run ? { run } : {}), ...(rules ? { rules } : {}), ...(settings ? { settings } : {}), ...stepField,
    fields: frames.reduce((n, f) => n + (f.fields ?? 0), 0),
    rounds: Math.max(0, ...frames.map((f) => f.rounds ?? 0)),
    filled: all('filled').length, kept: all('kept').length, noData: all('noData').length,
    failed: all('failed').length, leftRequired: all('leftRequired').length,
    unknown: all('unknown').length,
    clicked: all('actions').filter((a) => !a.alreadyShown).map((a) => a.id),
    blockers: all('blockers').length,
    // Why the page wasn't continued: "differs: Zip code", "button: recalculate", … (no values).
    blockerList: all('blockers').slice(0, 12).map((b) => redact(String(b)).slice(0, 120)),
    advanced: frames.find((f) => f.advanced)?.advanced ?? null,
    // The carrier probably changed the page (pagekit fill): known fields reworded or renamed.
    pageChanged: frames.some((f) => f.pageChanged),
    reworded: all('reworded').length,
    renamed: all('renamed').slice(0, 12).map((x) => ({ name: redact(x.name), field: x.field ?? null, now: x.now ?? null })),
  }];
  const item = (result) => (x) => ({
    type: 'fill_field', carrier, page, view, ...(run ? { run } : {}), ...stepField, result, q: x.q ?? null, key: fieldKeyOf(x.key, redact, keySalt), label: redact(x.label), path: x.path ?? null, controlKind: x.controlKind ?? null,
    how: x.how ?? undefined,
    // Why this answer: where it comes from (intake, derived, standard, fact, attestation), a TNI
    // standard, the agent's only (never the AI's), and a review-mode answer the agent confirms.
    ...(x.source ? { source: x.source } : {}), ...(x.standard ? { standard: true } : {}), ...(x.manualOnly ? { manualOnly: true } : {}), ...(x.review ? { review: true } : {}),
    shown: result === 'filled' && isChoice(x) ? redact(x.shown) : undefined,
    reason: x.reason ? redact(x.reason) : undefined,
    options: x.options?.map(redact),
    // Per-answer timing and side effects (filled answers only): see scripts/review.mjs, Speed.
    ...(x.timing ? { timing: x.timing } : {}),
  });
  events.push(...all('filled').map(item('filled')), ...all('failed').map(item('failed')), ...all('noData').map(item('noData')),
    ...all('kept').map(item('kept')), ...all('leftRequired').map(item('leftRequired')), ...all('unknown').map(item('unfamiliar')));
  return events;
}
