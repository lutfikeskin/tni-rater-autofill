// @ts-check
// The kit's trace: what a fill waits for, presses and answers. Always kept in a short ring, value
// free (a field's key and label, a button's text, waits and their ms, never an answer), whose tail a
// fill that halts or fails an answer carries in its report (`timeline`, docs/browser-filling.md); and
// sent as rater-trace events while a developer recording runs (setTracing).

/** @import { TimelineEvent } from '../../types.js' */

let tracing = false;

/**
 * Returns whether recording trace emission is currently enabled.
 * @returns {boolean}
 */
export const isTracing = () => tracing;

/**
 * Enables or disables recording trace emission.
 * @param {boolean} value
 */
export const setTracing = (value) => { tracing = !!value; };

// The ring: the last RING events, of this fill (traceReset as each fill starts).
const RING = 300;
/** @type {Record<string, any>[]} */
const ring = [];

/** Empties the ring: a fill's timeline is its own. */
export const traceReset = () => { ring.length = 0; };

/**
 * Records a trace event in the ring, and dispatches it as a rater-trace custom event for a
 * developer recording.
 * @param {string} what
 * @param {Record<string, any>} [detail]
 */
export function kitTrace(what, detail = {}) {
  const event = { what, t: Date.now(), ...detail };
  ring.push(event);
  if (ring.length > RING) ring.shift();
  if (!tracing) return;
  try {
    document.dispatchEvent(new CustomEvent('rater-trace', { detail: JSON.stringify(event) }));
  } catch {
    /* no CustomEvent */
  }
}

const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * The ring's last `n` events, compact and value free: `at` ms after the ring's first event; a wait's
 * `why`, `ms` and how it `ended` (and what `held` it at its limit); a press's `button` text and `how`;
 * an answer's field `key`, `label`, step `kind`, `ok` and `ms`.
 * @param {number} [n]
 * @returns {TimelineEvent[]}
 */
export function traceTail(n = 40) {
  const t0 = ring[0]?.t ?? 0;
  return ring.slice(-n).map((e) => {
    /** @type {TimelineEvent} */
    const out = { what: String(e.what).slice(0, 20), at: e.t - t0 };
    if (e.what === 'wait') Object.assign(out, { why: text(e.why, 40) ?? null, ms: num(e.ms), ended: text(e.ended, 20),
      ...(e.held ? { held: Object.keys(e.held).filter((k) => e.held[k] === true).slice(0, 4) } : {}) });
    else if (e.what === 'press') Object.assign(out, { button: text(e.button?.text, 60) ?? '', how: text(e.how, 10) });
    else if (e.what === 'answer') Object.assign(out, { key: text(e.field?.key, 120) ?? null, label: text(e.field?.label, 120) ?? '', kind: text(e.stepKind, 30) ?? null, ok: !!e.ok, ms: num(e.timing?.ms ?? e.applyMs) });
    else if (e.what === 'run') Object.assign(out, { on: !!e.on });
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  });
}
