// @ts-check
// The developer recording's plain parts (docs/developer-recording.md): who may record, a
// recording's id and manifest, how the panel stamps and redacts the trace's events
// (src/content/trace.js), and the files a recording is saved as. The side panel's store
// (sidepanel/recording.js) keeps them while recording and zips them on Stop and save.

/** @import { TraceEvent, RecordingManifest } from '../types.js' */

// 2 (REC-10, 2026-11-07): the manifest says what a run needs to be reproduced (session, rules,
// agent defaults, filling switches, platform, the trace's and recorder's versions).
export const RECORDING_VERSION = 2;

/**
 * Developer mode only where the build isn't the store's: the repository loaded as it is
 * (`source`) or the packaged unpacked copy (the maintainer's decision, 2026-10-23).
 * @param {string | null | undefined} channel
 */
export function canRecord(channel) {
  return channel === 'source' || channel === 'unpacked';
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * `<carrier>-<scenario>-<yyyymmdd-hhmm>-<4 hex>`, in local time; the scenario as a slug.
 * @param {string} carrier
 * @param {string} scenario
 * @param {Date} [date]
 * @param {() => number} [random]
 */
export function recordingId(carrier, scenario, date = new Date(), random = Math.random) {
  const slug = String(scenario ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'unnamed';
  const when = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const hex = Math.floor(random() * 0x10000).toString(16).padStart(4, '0');
  return `${carrier}-${slug}-${when}-${hex}`;
}

/**
 * A batch of the trace's events as the recording keeps them: the frame it came from, whether a
 * fill was under way when it happened (`fillingAt`, by its own time), and the words that may hold a
 * client's name or number redacted (labels and keys, those of the questions a page drew too,
 * button words, a choice's words, the title, a path). Keys are the data-model names the usage log keeps,
 * where the page has them.
 * A step is kept only as one of the carrier's step names (`stepName`: the usage log's knownStep),
 * redacted too: the trace reads a page's headings, which on Progressive are no steps and name the
 * drivers ("A few more questions about …", live recording, 2026-10-23). A step event that names no
 * new step then goes.
 * @param {any[]} events
 * @param {{ frame?: number, fillingAt?: (t: number) => boolean, redact?: (s: string) => string, stepName?: (headings: string) => string | null }} where
 * @returns {TraceEvent[]}
 */
export function stampEvents(events, { frame = 0, fillingAt = () => false, redact = (s) => s, stepName = () => null } = {}) {
  const words = (s) => (typeof s === 'string' ? redact(s) : s);
  const step = (s) => { const name = s == null ? null : stepName(String(s)); return name == null ? null : redact(String(name)); };
  return (Array.isArray(events) ? events : []).filter((e) => e && typeof e.kind === 'string' && typeof e.t === 'number').map((e) => {
    const out = { ...e, frame };
    if (fillingAt(e.t)) out.filling = true;
    // A key is redacted too: one that is no data-model name may be built from a control's name or
    // id, which a carrier could make of a client's name (review of PR #257).
    if (out.field) out.field = { ...out.field, key: words(out.field.key ?? null), label: words(out.field.label ?? '') };
    if (out.button) out.button = { ...out.button, text: words(out.button.text ?? '') };
    // The questions a page's burst drew (src/content/trace.js), named as a field is.
    if (Array.isArray(out.drawn)) out.drawn = out.drawn.map((d) => ({ ...d, key: words(d?.key ?? null), label: words(d?.label ?? '') }));
    for (const k of ['value', 'title', 'text', 'path']) if (typeof out[k] === 'string') out[k] = words(out[k]);
    if ('step' in out) out.step = step(out.step);
    if (out.kind === 'step') out.from = step(out.from);
    return out;
  }).filter((e) => !(e.kind === 'step' && e.step === e.from));
}

/**
 * What a run needs to be reproduced, beside the build: the usage session (to join the usage
 * log's events), the rules' and the agent's defaults' fingerprints, the filling switches as the
 * recording began, the platform, and the trace's and recorder's versions (as the trace says them).
 * @param {{ id: string, carrier: string, scenario: string, started: Date | string, build: RecordingManifest['build'], intake?: string | null, test?: boolean,
 *   session?: string | null, rules?: string | null, defaultsHash?: string | null, settings?: RecordingManifest['settings'], platform?: string | null }} start
 * @returns {RecordingManifest}
 */
export function newManifest({ id, carrier, scenario, started, build, intake = null, test = false, session = null, rules = null, defaultsHash = null, settings = null, platform = null }) {
  return {
    tool: 'tni-rater-autofill', kind: 'recording', version: RECORDING_VERSION, id, carrier, scenario,
    started: new Date(started).toISOString(), ended: null, build, intake, test, events: 0, dropped: 0,
    session, rules, defaultsHash, settings, platform, versions: { trace: null, recorder: null },
  };
}

/**
 * The files of a saved recording: its manifest and its timeline, the events in the order they
 * happened (by time, then each frame's counter), and the page layouts its moments took
 * (`layouts/0001.json`, REC-05), each named by the `moment` event that took it.
 * @param {RecordingManifest} manifest
 * @param {TraceEvent[]} events
 * @param {{ [name: string]: string }} [layouts]
 * @returns {{ [name: string]: string }}
 */
export function recordingFiles(manifest, events, layouts = {}) {
  const ordered = [...events].sort((a, b) => a.t - b.t || (a.frame ?? 0) - (b.frame ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  const dropped = ordered.filter((e) => e.kind === 'gap').reduce((n, e) => n + (e.dropped ?? 0), 0);
  const final = { ...manifest, events: ordered.length, dropped };
  return {
    'recording.json': `${JSON.stringify(final, null, 2)}\n`,
    'events.jsonl': ordered.map((e) => JSON.stringify(e)).join('\n') + (ordered.length ? '\n' : ''),
    ...Object.fromEntries(Object.entries(layouts).filter(([name]) => /^layouts\/\d{4}\.json$/.test(name))),
  };
}
