// @ts-check
// The developer recording's plain parts (docs/developer-recording.md): who may record, a
// recording's id and manifest, how the panel stamps and redacts the trace's events
// (src/content/trace.js), and the files a recording is saved as. The side panel's store
// (sidepanel/recording.js) keeps them while recording and zips them on Stop and save.

/** @import { TraceEvent, RecordingManifest } from '../types.js' */

export const RECORDING_VERSION = 1;

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
 * fill was under way, and the words that may hold a client's name or number redacted (labels,
 * button words, a choice's words, the title). Keys are the data-model names the usage log keeps.
 * @param {any[]} events
 * @param {{ frame?: number, filling?: boolean, redact?: (s: string) => string }} where
 * @returns {TraceEvent[]}
 */
export function stampEvents(events, { frame = 0, filling = false, redact = (s) => s } = {}) {
  const words = (s) => (typeof s === 'string' ? redact(s) : s);
  return (Array.isArray(events) ? events : []).filter((e) => e && typeof e.kind === 'string' && typeof e.t === 'number').map((e) => {
    const out = { ...e, frame };
    if (filling) out.filling = true;
    if (out.field) out.field = { ...out.field, label: words(out.field.label ?? '') };
    if (out.button) out.button = { ...out.button, text: words(out.button.text ?? '') };
    for (const k of ['value', 'title', 'text']) if (typeof out[k] === 'string') out[k] = words(out[k]);
    return out;
  });
}

/**
 * @param {{ id: string, carrier: string, scenario: string, started: Date | string, build: RecordingManifest['build'], intake?: string | null, test?: boolean }} start
 * @returns {RecordingManifest}
 */
export function newManifest({ id, carrier, scenario, started, build, intake = null, test = false }) {
  return {
    tool: 'tni-rater-autofill', kind: 'recording', version: RECORDING_VERSION, id, carrier, scenario,
    started: new Date(started).toISOString(), ended: null, build, intake, test, events: 0, dropped: 0,
  };
}

/**
 * The files of a saved recording: its manifest and its timeline, the events in the order they
 * happened (by time, then each frame's counter).
 * @param {RecordingManifest} manifest
 * @param {TraceEvent[]} events
 * @returns {{ [name: string]: string }}
 */
export function recordingFiles(manifest, events) {
  const ordered = [...events].sort((a, b) => a.t - b.t || (a.frame ?? 0) - (b.frame ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  const dropped = ordered.filter((e) => e.kind === 'gap').reduce((n, e) => n + (e.dropped ?? 0), 0);
  const final = { ...manifest, events: ordered.length, dropped };
  return {
    'recording.json': `${JSON.stringify(final, null, 2)}\n`,
    'events.jsonl': ordered.map((e) => JSON.stringify(e)).join('\n') + (ordered.length ? '\n' : ''),
  };
}
