// Usage log: what agents do with the extension, recorded so the mappings and rules can be
// improved from real quotes. Recorded without client data:
//  - the intake is identified by a SHA-256 fingerprint of the PDF, never by name or file name;
//  - warnings are logged by code, not by their text (which quotes client details);
//  - dropdown/radio choices are logged as option text (client names redacted);
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
    if (path.startsWith('claims.text')) continue;
    const norm = normalizeForMatch(value);
    if (norm.length >= 3 && norm === want) hits.push(path);
    // Phone and ID numbers are often typed in parts.
    else if (/phone/.test(path) && /^\d{3,4}$/.test(want) && norm.includes(want)) hits.push(`${path}:part`);
  }
  return hits.slice(0, 5);
}

export function redactor(terms) {
  const patterns = terms.filter((t) => t && t.length >= 3).map((t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  return (s) => (s == null ? s : patterns.reduce((acc, re) => acc.replace(re, '[client]'), String(s)));
}

// ---------------------------------------------------------------------------------------------
// Events

// Values that look typed rather than picked from a list. If the recorder ever mistakes a typed
// box for a dropdown (date pickers look like dropdowns), these still never reach the log.
const LOOKS_TYPED = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|@|\d{5,}/;

/**
 * Turns one field change seen on the rater page into a log event.
 * @param {{key, q, label, kind, before, after, agent}} change  from the page recorder (raw values)
 * @param {{record, filled: Map, redact: Function, labels?: Map}} ctx  filled: field key -> what
 *   autofill put there; labels: field key -> question text as the fill engine read it (more
 *   reliable than the recorder's guess)
 */
export function fieldChangeEvent(change, { record, filled, redact, labels }) {
  const ours = filled.get(change.key) ?? null;
  const kind = change.kind !== 'text' && (LOOKS_TYPED.test(redact(change.before ?? '')) || LOOKS_TYPED.test(redact(change.after ?? ''))) ? 'text' : change.kind;
  const base = {
    type: 'field_change',
    q: change.q ?? null,
    label: redact(labels?.get(change.key) ?? change.label),
    kind,
    by: change.agent ? 'agent' : 'page',
    autofilled: ours ? ours.path : null,
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
  return {
    ...base,
    from: redact(change.before) || null,
    to: redact(change.after) || null,
    vsAutofill: ours ? (ours.shown === change.after ? 'same' : 'different') : undefined,
  };
}

// Fill results, minus typed values (text boxes) and client names.
export function fillEvents(frames, { carrier, page, overwrite, ms, redact }) {
  const all = (k) => frames.flatMap((f) => f[k] ?? []);
  const isChoice = (x) => x.controlKind && x.controlKind !== 'text';
  const events = [{
    type: 'fill_run', carrier, page, overwrite, ms,
    fields: frames.reduce((n, f) => n + (f.fields ?? 0), 0),
    rounds: Math.max(0, ...frames.map((f) => f.rounds ?? 0)),
    filled: all('filled').length, kept: all('kept').length, noData: all('noData').length,
    failed: all('failed').length, leftRequired: all('leftRequired').length,
  }];
  const item = (result) => (x) => ({
    type: 'fill_field', carrier, page, result, q: x.q ?? null, label: redact(x.label), path: x.path ?? null, controlKind: x.controlKind ?? null,
    shown: result === 'filled' && isChoice(x) ? redact(x.shown) : undefined,
    reason: x.reason ? redact(x.reason) : undefined,
    options: x.options?.map(redact),
  });
  events.push(...all('filled').map(item('filled')), ...all('failed').map(item('failed')), ...all('noData').map(item('noData')),
    ...all('kept').map(item('kept')), ...all('leftRequired').map(item('leftRequired')));
  return events;
}
